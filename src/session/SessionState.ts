import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import type { Agent } from '../agent/Agent.js';
import type { BladeConfig } from '../agent/config.js';
import type { InitialInputPreparation } from '../agent/InitialInputPreparation.js';
import type { UserMessageContent } from '../agent/types.js';
import { ConfigError } from '../errors/ConfigError.js';
import type { CleanupHandle } from '../lifecycle/CleanupRegistry.js';
import { createRootLogger, type InternalLogger, LogCategory } from '../logging/Logger.js';
import type { ModelConfig, ProviderConnectionConfig } from '../model/config.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelContent } from '../model/message.js';
import { type AgentTrace, TraceRecorder } from '../observability/index.js';
import type { ContextSnapshot, RuntimeContext } from '../runtime/index.js';
import { cloneMessage } from '../services/messageUtils.js';
import type { ConfirmationHandler } from '../tools/types/execution.js';
import { PermissionMode } from '../types/constants.js';
import { MessageId, type RequestId, SessionId } from '../types/identifiers.js';
import type { ActiveRequestController } from './ActiveRequestController.js';
import type { DurableExecutionLease } from './events/DurableExecutionLease.js';
import type { DurableExecutionLeaseError } from './events/DurableExecutionLeaseStore.js';
import type { DurableSessionJournal } from './events/DurableSessionJournal.js';
import type { DurableRequestProjection } from './events/DurableSessionProjector.js';
import { resolveDurableStoreTimeoutMs } from './events/DurableStoreOperation.js';
import type { SessionDurableRecorder } from './events/SessionDurableRecorder.js';
import { SERVER_SESSION_HOST, type SessionHostProfile } from './SessionHostProfile.js';
import { SessionInputInbox } from './SessionInputInbox.js';
import {
  NoopSessionRepository,
  type SessionEventStore,
  type SessionRepository,
} from './SessionRepository.js';
import type { SessionRuntime } from './SessionRuntime.js';
import type { SessionSnapshot } from './SessionStore.js';
import type {
  PendingSessionInput,
  SendOptions,
  SessionHandoffResult,
  SessionOptions,
} from './types.js';

export interface SessionStreamExecution {
  readonly completion: Promise<void>;
  readonly startedBeforeHandoff: boolean;
  releaseBackpressure(): void;
  isSettled(): boolean;
}

export type SessionExecutionState =
  | { phase: 'idle' }
  | {
      phase: 'pending';
      requestId: RequestId;
      input: PendingSessionInput;
      controller: ActiveRequestController;
      message: UserMessageContent;
      options: SendOptions | null;
      snapshot: ContextSnapshot;
      durableRecorder: SessionDurableRecorder | null;
      initialInputPreparation?: InitialInputPreparation;
    }
  | {
      phase: 'running';
      requestId: RequestId;
      controller: ActiveRequestController;
      durableRecorder: SessionDurableRecorder | null;
      execution: SessionStreamExecution;
    }
  | {
      phase: 'stopping';
      requestId: RequestId;
      controller: ActiveRequestController;
      durableRecorder: SessionDurableRecorder | null;
      execution: SessionStreamExecution;
    }
  | {
      phase: 'suspending';
      requestId: RequestId;
      controller: ActiveRequestController;
      durableRecorder: SessionDurableRecorder;
      execution: SessionStreamExecution;
    }
  | {
      phase: 'closed';
      disposition: 'terminal' | 'detached';
      execution?: SessionStreamExecution;
    };

export interface DurableSessionOrigin {
  source: 'create' | 'resume' | 'fork';
  parentSessionId?: SessionId;
}

export function hasSessionPersistence(options: SessionOptions): boolean {
  return options.sessionRepository !== undefined && options.sessionEventStore !== undefined;
}

export class SessionState {
  readonly sessionId: SessionId;
  agent: Agent | null = null;
  runtime: SessionRuntime | null = null;
  messages: ConversationMessage[] = [];
  readonly options: SessionOptions;
  readonly store: SessionRepository;
  readonly eventStore: SessionEventStore;
  readonly persistenceEnabled: boolean;
  readonly isResumeSession: boolean;
  readonly rootLogger: InternalLogger;
  readonly logger: InternalLogger;
  readonly durableStoreTimeoutMs: number;
  readonly confirmationHandler?: ConfirmationHandler;
  maxTurns: number;
  permissionMode: PermissionMode;
  defaultContext: RuntimeContext;
  initialized = false;
  cleanupHandle: CleanupHandle | null = null;
  readonly traces: AgentTrace[] = [];
  readonly inputInbox = new SessionInputInbox();
  readonly inputMutex = new Mutex();
  readonly streamExecutions = new Set<SessionStreamExecution>();
  durableJournal: DurableSessionJournal | null = null;
  durableAcceptedRequest: DurableRequestProjection | null = null;
  durableClosePromise: Promise<void> | null = null;
  executionLease: DurableExecutionLease | null = null;
  executionLeaseFailure: DurableExecutionLeaseError | null = null;
  executionLeaseLossCleanup: (() => void) | null = null;
  runtimeEndAttempted = false;
  closePromise: Promise<void> | null = null;
  handoffPromise: Promise<SessionHandoffResult> | null = null;
  handoffRequested = false;
  executionState: SessionExecutionState = { phase: 'idle' };

  constructor(
    options: SessionOptions,
    sessionId?: SessionId,
    isResume = false,
    readonly hostProfile: SessionHostProfile = SERVER_SESSION_HOST,
    readonly durableOrigin: DurableSessionOrigin = {
      source: isResume ? 'resume' : 'create',
    },
  ) {
    if (
      hostProfile === SERVER_SESSION_HOST &&
      options.persistSession !== false &&
      options.storagePath &&
      !options.sessionRepository
    ) {
      throw new ConfigError(
        'Server sessions require sessionRepository and sessionEventStore for persistence. ' +
          'Import from @blade-ai/agent-sdk/advanced to use storagePath-backed local persistence.',
      );
    }
    this.sessionId = sessionId || SessionId(nanoid());
    this.options = options;
    this.maxTurns = options.maxTurns ?? 200;
    this.permissionMode = options.permissionMode ?? PermissionMode.DEFAULT;
    this.defaultContext = resolveDefaultContext(options);
    this.durableStoreTimeoutMs = resolveDurableStoreTimeoutMs(options.durableStoreTimeoutMs);
    this.confirmationHandler =
      options.confirmationHandlerFactory?.(this.sessionId) ?? options.confirmationHandler;
    const eventStore = options.sessionEventStore;
    if (
      options.persistSession !== false &&
      ((options.sessionRepository && !eventStore) || (!options.sessionRepository && eventStore))
    ) {
      throw new ConfigError(
        'Persistent Sessions require both sessionRepository and sessionEventStore.',
      );
    }
    this.persistenceEnabled =
      options.persistSession !== false &&
      options.sessionRepository !== undefined &&
      eventStore !== undefined;
    const noopRepository = new NoopSessionRepository();
    this.store =
      this.persistenceEnabled && options.sessionRepository
        ? options.sessionRepository
        : noopRepository;
    this.eventStore = this.persistenceEnabled && eventStore ? eventStore : noopRepository;
    this.isResumeSession = isResume;
    this.rootLogger = createRootLogger(options.logger, this.sessionId);
    this.logger = this.rootLogger.child(LogCategory.AGENT);
  }

  get isClosed(): boolean {
    return (
      this.executionLeaseFailure !== null ||
      this.handoffRequested ||
      this.executionState.phase === 'suspending' ||
      this.executionState.phase === 'closed'
    );
  }

  buildBladeConfig(): BladeConfig {
    const modelConfig = this.buildModelConfig();

    return {
      models: [modelConfig],
      currentModelId: modelConfig.id,
      temperature: this.options.temperature ?? 0.7,
      toolTimeoutMs: this.options.toolTimeoutMs,
      webFetch: this.options.webFetch,
      permissions: {
        allow: [],
        deny: [],
      },
    };
  }

  getAgent(): Agent {
    if (!this.agent) {
      throw new Error('Session agent is not initialized');
    }
    return this.agent;
  }

  getRuntime(): SessionRuntime {
    if (!this.runtime) {
      throw new Error('Session runtime is not initialized');
    }
    return this.runtime;
  }

  runWithExecutionLease<T>(operation: () => Promise<T>): Promise<T> {
    return this.executionLease ? this.executionLease.runFenced(operation) : operation();
  }

  createTraceRecorder(message: UserMessageContent): TraceRecorder | undefined {
    const observability = this.options.observability;
    if (!observability?.enabled) {
      return undefined;
    }
    const recorder = new TraceRecorder(this.sessionId, observability, {
      model: this.options.model,
      provider: this.options.provider.id?.trim() || this.options.provider.type,
      permissionMode: this.permissionMode,
    });
    recorder.addEvent('user_prompt', { message });
    return recorder;
  }

  rememberTrace(trace: AgentTrace): void {
    this.traces.push(trace);
    const maxTraces = this.options.observability?.maxTraces ?? 20;
    while (this.traces.length > maxTraces) {
      this.traces.shift();
    }
  }

  async notifyTraceSink(trace: AgentTrace): Promise<void> {
    try {
      await this.options.observability?.sink?.(trace);
    } catch (error) {
      this.logger.warn('[Session] Observability trace sink failed:', error);
    }
  }

  cloneSnapshotMessages(snapshot: SessionSnapshot | null): ConversationMessage[] {
    return snapshot ? snapshot.messages.map(cloneMessage) : [];
  }

  createSnapshotFromMessages(messageId?: MessageId): SessionSnapshot {
    let messages = this.messages.map(cloneMessage);

    if (messageId) {
      const endIndex = messages.findIndex((message) => message.id === messageId);
      if (endIndex === -1) {
        throw new Error(`ModelMessage with ID "${messageId}" not found in session history`);
      }
      messages = messages.slice(0, endIndex + 1);
    }

    return {
      sessionId: this.sessionId,
      messages,
      messageIds: messages
        .map((message) => message.id)
        .filter((id): id is string => typeof id === 'string')
        .map(MessageId),
      lastActivity: Date.now(),
    };
  }

  getTextContent(message: UserMessageContent): string {
    if (typeof message === 'string') {
      return message;
    }
    return message
      .filter((part): part is Extract<ModelContent, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  getImageCount(message: UserMessageContent): number {
    return typeof message === 'string'
      ? 0
      : message.filter((part) => part.type === 'image_url').length;
  }

  private buildModelConfig(): ModelConfig {
    const provider = this.options.provider;
    const openAIHeaders =
      provider.type === 'openai'
        ? {
            ...(provider.organization ? { 'OpenAI-Organization': provider.organization } : {}),
            ...(provider.projectId ? { 'OpenAI-Project': provider.projectId } : {}),
          }
        : {};
    const headers = {
      ...provider.headers,
      ...openAIHeaders,
    };

    return {
      id: 'default',
      name: this.options.model,
      provider: provider.type,
      providerId: provider.id?.trim() || provider.type,
      model: this.options.model,
      apiKey: provider.apiKey || '',
      baseUrl: provider.baseUrl || getDefaultBaseUrl(provider.type),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      requestTimeoutMs: provider.requestTimeoutMs,
      streamIdleTimeoutMs: provider.streamIdleTimeoutMs,
      maxContextTokens: this.options.maxContextTokens ?? 128000,
      maxOutputTokens: this.options.maxOutputTokens,
      temperature: this.options.temperature,
      providerOptions: this.options.providerOptions,
      thinkingEnabled: this.options.thinkingEnabled,
      thinkingBudget: this.options.thinkingBudget,
    };
  }
}

function resolveDefaultContext(options: SessionOptions): RuntimeContext {
  const sandboxPolicy = options.defaultContext?.capabilities?.sandbox ?? options.sandbox;
  if (!sandboxPolicy) {
    return options.defaultContext ?? {};
  }

  return {
    ...(options.defaultContext ?? {}),
    capabilities: {
      ...(options.defaultContext?.capabilities ?? {}),
      sandbox: {
        ...sandboxPolicy,
        ...(sandboxPolicy.excludedCommands
          ? { excludedCommands: [...sandboxPolicy.excludedCommands] }
          : {}),
        ...(sandboxPolicy.ignoreViolations
          ? {
              ignoreViolations: {
                ...(sandboxPolicy.ignoreViolations.file
                  ? { file: [...sandboxPolicy.ignoreViolations.file] }
                  : {}),
                ...(sandboxPolicy.ignoreViolations.network
                  ? { network: [...sandboxPolicy.ignoreViolations.network] }
                  : {}),
              },
            }
          : {}),
        ...(sandboxPolicy.network
          ? {
              network: {
                ...sandboxPolicy.network,
                ...(sandboxPolicy.network.allowUnixSockets
                  ? { allowUnixSockets: [...sandboxPolicy.network.allowUnixSockets] }
                  : {}),
              },
            }
          : {}),
      },
    },
  };
}

function getDefaultBaseUrl(type: ProviderConnectionConfig['type']): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    'openai-compatible': 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com',
    deepseek: 'https://api.deepseek.com',
    'azure-openai': '',
  };
  return urls[type] || '';
}
