import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { Agent } from '../agent/Agent.js';
import type { BladeConfig } from '../agent/config.js';
import {
  type InitialInputPreparation,
  RECONCILED_INITIAL_INPUT,
} from '../agent/InitialInputPreparation.js';
import type { ChatContext, LoopResult, UserMessageContent } from '../agent/types.js';
import { ConfigError } from '../errors/ConfigError.js';
import { SessionHandoffError } from '../errors/SessionHandoffError.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { isHookProcessContainmentError } from '../hooks/WindowsProcessJob.js';
import { type CleanupHandle, registerCleanup } from '../lifecycle/CleanupRegistry.js';
import { createRootLogger, type InternalLogger, LogCategory } from '../logging/Logger.js';
import type { ModelConfig, ProviderConnectionConfig } from '../model/config.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import type { TokenUsage } from '../model/usage.js';
import { type AgentTrace, TraceRecorder } from '../observability/index.js';
import {
  type ContextSnapshot,
  createContextSnapshot,
  type RuntimeContext,
} from '../runtime/index.js';
import { cloneMessage } from '../services/messageUtils.js';
import type { ConfirmationHandler } from '../tools/types/execution.js';
import { PermissionMode } from '../types/constants.js';
import {
  CommandId,
  type EventSequence,
  InputId,
  MessageId,
  RequestId,
  SessionId,
  type SpanId,
  ToolUseId,
} from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { ActiveRequestController, type RequestAbortReason } from './ActiveRequestController.js';
import {
  parseDurableRuntimeContext,
  parseDurableUserMessageContent,
  serializeDurableRuntimeContext,
} from './DurableRequestRecovery.js';
import {
  DurableEventSubscription,
  DurableEventSubscriptionError,
  type DurableEventSubscriptionOptions,
} from './events/DurableEventSubscription.js';
import { DurableExecutionLease } from './events/DurableExecutionLease.js';
import {
  DurableExecutionLeaseError,
  type DurableExecutionLease as DurableExecutionLeaseSnapshot,
} from './events/DurableExecutionLeaseStore.js';
import { DurableSessionJournal } from './events/DurableSessionJournal.js';
import type {
  DurableRequestProjection,
  DurableSessionProjection,
  DurableSessionRecoveryPlan,
} from './events/DurableSessionProjector.js';
import { DurableSessionRecoveryCoordinator } from './events/DurableSessionRecoveryCoordinator.js';
import { resolveDurableStoreTimeoutMs } from './events/DurableStoreOperation.js';
import {
  type DurableRequestFinish,
  DurableSessionRecoveryRequiredError,
  durableRequestFinishFromLoopResult,
  SessionDurableRecorder,
  SessionDurableRecorderError,
} from './events/SessionDurableRecorder.js';
import { DurableEventType, type DurableRequestInterruptReason } from './events/types.js';
import {
  NODE_SESSION_HOST,
  SERVER_SESSION_HOST,
  type SessionHostProfile,
} from './SessionHostProfile.js';
import { SessionInputInbox } from './SessionInputInbox.js';
import {
  isSessionEventStore,
  NoopSessionRepository,
  type SessionEventStore,
  type SessionRepository,
} from './SessionRepository.js';
import { SessionRuntime } from './SessionRuntime.js';
import type { SessionSnapshot, SessionState } from './SessionStore.js';
import { SessionStreamChannel } from './SessionStreamChannel.js';
import type {
  ForkSessionOptions,
  InputSubmission,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PendingSessionInput,
  PromptResult,
  SendOptions,
  SessionHandoffResult,
  SessionOptions,
  SessionStreamEvent,
  StreamOptions,
  ToolExecutionRecord,
} from './types.js';
import { InputPriority } from './types.js';

export interface ResumeOptions extends SessionOptions {
  sessionId: SessionId;
}

function hasSessionPersistence(options: SessionOptions): boolean {
  return (
    options.sessionRepository !== undefined &&
    (options.sessionEventStore !== undefined || isSessionEventStore(options.sessionRepository))
  );
}

interface SessionStreamExecution {
  readonly completion: Promise<void>;
  readonly startedBeforeHandoff: boolean;
  releaseBackpressure(): void;
  isSettled(): boolean;
}

type SessionExecutionState =
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

class Session implements ISession {
  readonly sessionId: SessionId;
  private agent: Agent | null = null;
  private runtime: SessionRuntime | null = null;
  private _messages: ModelMessage[] = [];
  private readonly options: SessionOptions;
  private readonly store: SessionRepository;
  private readonly eventStore: SessionEventStore;
  private readonly persistenceEnabled: boolean;
  private readonly isResumeSession: boolean;
  private readonly rootLogger: InternalLogger;
  private readonly logger: InternalLogger;
  private readonly durableStoreTimeoutMs: number;
  private readonly confirmationHandler?: ConfirmationHandler;
  private maxTurns: number;
  private permissionMode: PermissionMode;
  private defaultContext: RuntimeContext;
  private initialized = false;
  private cleanupHandle: CleanupHandle | null = null;
  private readonly traces: AgentTrace[] = [];
  private readonly inputInbox = new SessionInputInbox();
  private readonly inputMutex = new Mutex();
  private readonly streamExecutions = new Set<SessionStreamExecution>();
  private durableJournal: DurableSessionJournal | null = null;
  private durableAcceptedRequest: DurableRequestProjection | null = null;
  private durableClosePromise: Promise<void> | null = null;
  private executionLease: DurableExecutionLease | null = null;
  private executionLeaseFailure: DurableExecutionLeaseError | null = null;
  private executionLeaseLossCleanup: (() => void) | null = null;
  private runtimeEndAttempted = false;
  private closePromise: Promise<void> | null = null;
  private handoffPromise: Promise<SessionHandoffResult> | null = null;
  private handoffRequested = false;

  /**
   * 请求阶段状态机：
   * - idle: 无待处理请求
   * - pending: send() 已调用，等待 stream() 消费
   * - running: stream() 正在执行
   * - stopping: 已请求中止，等待 stream() 完成清理
   * - suspending: 正在停止本地执行并保留 durable 恢复边界
   * - closed: 本地会话已关闭
   *
   * 防止在 streaming 期间再次调用 send() 产生并发 generator 竞态。
   */
  private executionState: SessionExecutionState = { phase: 'idle' };

  constructor(
    options: SessionOptions,
    sessionId?: SessionId,
    isResume = false,
    private readonly hostProfile: SessionHostProfile = SERVER_SESSION_HOST,
    private readonly durableOrigin: {
      source: 'create' | 'resume' | 'fork';
      parentSessionId?: SessionId;
    } = { source: isResume ? 'resume' : 'create' },
  ) {
    if (
      hostProfile === SERVER_SESSION_HOST &&
      options.persistSession !== false &&
      options.storagePath &&
      !options.sessionRepository
    ) {
      throw new ConfigError(
        'Server sessions require sessionRepository and sessionEventStore for persistence. ' +
          'Import from @blade-ai/agent-sdk/node to use storagePath-backed local persistence.',
      );
    }
    this.sessionId = sessionId || SessionId(nanoid());
    this.options = options;
    this.maxTurns = options.maxTurns ?? 200;
    this.permissionMode = options.permissionMode ?? PermissionMode.DEFAULT;
    this.defaultContext = options.defaultContext ?? {};
    this.durableStoreTimeoutMs = resolveDurableStoreTimeoutMs(options.durableStoreTimeoutMs);
    this.confirmationHandler =
      options.confirmationHandlerFactory?.(this.sessionId) ?? options.confirmationHandler;
    const eventStore =
      options.sessionEventStore ??
      (isSessionEventStore(options.sessionRepository) ? options.sessionRepository : undefined);
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

  get messages(): ModelMessage[] {
    return [...this._messages];
  }

  get isClosed(): boolean {
    return (
      this.executionLeaseFailure !== null ||
      this.handoffRequested ||
      this.executionState.phase === 'suspending' ||
      this.executionState.phase === 'closed'
    );
  }

  getDefaultContext(): RuntimeContext {
    return this.defaultContext;
  }

  setDefaultContext(context: RuntimeContext): void {
    this.defaultContext = context;
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traces.at(-1);
  }

  getTraces(): AgentTrace[] {
    return [...this.traces];
  }

  getDurableProjection(): DurableSessionProjection | null {
    return this.durableJournal?.getProjection() ?? null;
  }

  getDurableRecoveryPlan(): DurableSessionRecoveryPlan | null {
    return this.durableJournal?.getRecoveryPlan() ?? null;
  }

  getExecutionLease(): DurableExecutionLeaseSnapshot | null {
    return this.executionLease?.snapshot ?? null;
  }

  /** Replays persisted lifecycle events, then follows newly committed events. */
  async subscribeDurableEvents(
    options: DurableEventSubscriptionOptions = {},
  ): Promise<DurableEventSubscription> {
    await this.ensureInitialized();
    const store = this.options.durableEventStore;
    if (!store) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_NOT_CONFIGURED',
        'Session durable event subscription requires durableEventStore',
      );
    }
    return DurableEventSubscription.open(store, this.sessionId, {
      ...options,
      storeTimeoutMs: Math.min(
        options.storeTimeoutMs ?? this.durableStoreTimeoutMs,
        this.durableStoreTimeoutMs,
      ),
    });
  }

  async initialize(): Promise<void> {
    if (this.executionLeaseFailure) {
      throw this.executionLeaseFailure;
    }
    if (
      this.handoffRequested ||
      this.executionState.phase === 'suspending' ||
      this.executionState.phase === 'closed'
    ) {
      throw new Error('Session is closed');
    }
    if (this.initialized) return;

    await this.initializeExecutionLease();
    try {
      await this.initializeDurableJournal();
      const config = this.buildBladeConfig();
      this.runtime = new SessionRuntime(
        this.sessionId,
        this.options,
        config,
        this.permissionMode,
        this.defaultContext,
        this.rootLogger,
        this.hostProfile,
        this.store,
        this.eventStore,
      );
      await this.runtime.initialize();
      if (this.isResumeSession) {
        await this.runWithExecutionLease(() => this.getRuntime().ensureSessionLoaded());
      } else {
        await this.runWithExecutionLease(() => this.getRuntime().ensureSessionCreated());
      }

      this.agent = await Agent.create(
        config,
        {
          permissionMode: this.permissionMode,
          systemPrompt: this.options.systemPrompt,
          maxTurns: this.maxTurns,
          permissionHandler: this.options.permissionHandler,
          canUseTool: this.options.canUseTool,
          toolSourcePolicy: this.options.toolSourcePolicy,
          outputFormat: this.options.outputFormat,
          sandbox: this.options.sandbox,
          tokenBudget: this.options.tokenBudget,
          localDiscovery: this.hostProfile === NODE_SESSION_HOST,
        },
        this.runtime.getAgentRuntimeDeps(),
      );

      this.executionLeaseLossCleanup =
        this.executionLease?.onLost((error) => {
          this.handleExecutionLeaseLoss(error);
        }) ?? null;
      await this.executionLease?.assertActive();
      await this.runtime.getHookRuntime().runSessionStart({
        isResume: this.isResumeSession,
        resumeSessionId: this.isResumeSession ? this.sessionId : undefined,
        abortSignal: this.executionLease?.signal,
      });
      await this.executionLease?.assertActive();
      if (this.executionLeaseFailure) {
        throw this.executionLeaseFailure;
      }
      this.initialized = true;
      this.cleanupHandle = registerCleanup(() => this.close());

      this.logger.debug(`[Session] Initialized session ${this.sessionId}`);
    } catch (error) {
      const cleanupErrors = await this.releaseLocalRuntime();
      if (cleanupErrors.length === 0) {
        try {
          await this.releaseExecutionLease();
        } catch (leaseError) {
          this.executionLease?.abandon(leaseError);
          cleanupErrors.push(leaseError);
        }
      } else {
        this.executionLease?.abandon(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Session ${this.sessionId} initialization failed during cleanup`,
        );
      }
      throw error;
    }
  }

  async loadHistory(): Promise<void> {
    let state: SessionState | null = null;
    try {
      state = await this.store.loadState(this.sessionId);
    } catch (error) {
      if (this.durableAcceptedRequest) {
        throw new SessionDurableRecorderError(
          `Failed to load history before resuming request ${this.durableAcceptedRequest.requestId}`,
          { cause: error },
        );
      }
      throw error;
    }
    const durableProjection = this.durableJournal?.getProjection();
    const reconciledHistoryInputIds = new Set<string>(durableProjection?.reconciledInputIds ?? []);
    this._messages = (state?.messages ?? []).filter((message) => {
      const metadata = message.metadata;
      const messageInputId =
        typeof metadata === 'object' &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        typeof metadata.inputId === 'string'
          ? metadata.inputId
          : null;
      return messageInputId === null || !reconciledHistoryInputIds.has(messageInputId);
    });
    // Durable acceptance is authoritative. The legacy queue remains a
    // best-effort message/history projection and may be missing after a crash.
    await this.inputMutex.runExclusive(() => {
      const durableAcceptedRequest = this.durableAcceptedRequest;
      if (durableAcceptedRequest) {
        this.restoreDurableAcceptedRequest(durableAcceptedRequest);
      }
      const consumedInputIds = new Set([
        ...(durableProjection?.appliedInputIds ?? []),
        ...(durableProjection?.reconciledInputIds ?? []),
        ...(durableAcceptedRequest?.reconciledInputIds ?? []),
        ...(durableAcceptedRequest ? [durableAcceptedRequest.inputId] : []),
      ]);
      const dropped = this.inputInbox.restore(
        (state?.pendingInputs ?? [])
          .filter((input) => !consumedInputIds.has(input.inputId))
          .map((input) => ({
            ...input,
            content: input.content as UserMessageContent,
          })),
      );
      if (dropped > 0) {
        this.logger.warn(
          `[Session] Dropped ${dropped} pending input(s) exceeding queue capacity while restoring session ${this.sessionId}`,
        );
      }
      if (this.executionState.phase === 'idle') {
        this.scheduleNextQueuedInput();
      }
    });
    if (this._messages.length === 0) {
      this.logger.debug(`[Session] No history found for session ${this.sessionId}`);
      return;
    }
    this.logger.debug(`[Session] Loaded ${this._messages.length} messages from history`);
  }

  private buildBladeConfig(): BladeConfig {
    const modelConfig = this.buildModelConfig();

    return {
      models: [modelConfig],
      currentModelId: modelConfig.id,
      temperature: this.options.temperature ?? 0.7,
      toolTimeoutMs: this.options.toolTimeoutMs,
      permissions: {
        allow: [],
        deny: [],
      },
    };
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
      baseUrl: provider.baseUrl || this.getDefaultBaseUrl(provider.type),
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

  private getDefaultBaseUrl(type: ProviderConnectionConfig['type']): string {
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

  async send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission> {
    await this.ensureInitialized();

    return this.inputMutex.runExclusive(async () => {
      if (this.executionLeaseFailure) {
        throw this.executionLeaseFailure;
      }
      if (this.executionState.phase === 'suspending' || this.executionState.phase === 'closed') {
        throw new Error('Session is closed');
      }

      const inputId = InputId(nanoid());
      if (this.executionState.phase === 'idle') {
        this.assertDurableReadyForNewRequest();
        if (options?.expectedRequestId) {
          throw new SessionInputError(
            'SESSION_REQUEST_MISMATCH',
            `No active request matches "${options.expectedRequestId}"`,
          );
        }
        const requestId = RequestId(nanoid());
        const input: PendingSessionInput = {
          inputId,
          content: message,
          priority: InputPriority.NEXT,
          targetRequestId: requestId,
          acceptedAt: Date.now(),
        };
        const durableRecorder = this.durableJournal
          ? new SessionDurableRecorder(this.durableJournal, requestId, this.options.model)
          : null;
        const pendingState = this.createPendingState(requestId, input, options, durableRecorder);
        this.inputInbox.reserve(input);
        try {
          await durableRecorder?.recordAccepted(
            inputId,
            message,
            'next',
            this.durableExecutionSnapshot(pendingState),
          );
          try {
            await this.persistInput(input);
          } catch (error) {
            if (!durableRecorder) {
              throw error;
            }
            this.logger.warn(
              '[Session] Legacy input persistence failed after durable acceptance:',
              error,
            );
          }
          this.inputInbox.markCommitted(inputId);
        } catch (error) {
          pendingState.controller.dispose();
          this.inputInbox.remove(inputId);
          throw error;
        }
        this.executionState = pendingState;
        return {
          status: 'started',
          inputId,
          requestId,
        };
      }

      if (options?.signal || options?.maxTurns !== undefined || options?.context) {
        throw new SessionInputError(
          'SESSION_INPUT_OPTIONS_UNSUPPORTED',
          'signal, maxTurns, and context can only be set when starting an idle request',
        );
      }

      let priority = options?.priority ?? InputPriority.NEXT;
      const activeRequestId = this.executionState.requestId;
      const activeController = this.executionState.controller;
      if (options?.expectedRequestId && options.expectedRequestId !== activeRequestId) {
        throw new SessionInputError(
          'SESSION_REQUEST_MISMATCH',
          `Expected request "${options.expectedRequestId}" but "${activeRequestId}" is active`,
        );
      }
      let canSteerCurrentRequest =
        priority !== InputPriority.LATER &&
        this.executionState.phase !== 'stopping' &&
        (this.executionState.phase !== 'running' || !this.executionState.controller.isSealed);
      if (!canSteerCurrentRequest) {
        priority = InputPriority.LATER;
      }

      const input: PendingSessionInput = {
        inputId,
        content: message,
        priority,
        targetRequestId: canSteerCurrentRequest ? activeRequestId : undefined,
        acceptedAt: Date.now(),
      };
      this.inputInbox.reserve(input);
      try {
        await this.persistInput(input);
        const requestStillAcceptsSteering =
          (this.executionState.phase === 'pending' || this.executionState.phase === 'running') &&
          this.executionState.requestId === activeRequestId &&
          !activeController.isSealed;
        if (canSteerCurrentRequest && !requestStillAcceptsSteering) {
          canSteerCurrentRequest = false;
          priority = InputPriority.LATER;
          this.inputInbox.retargetLater(inputId);
        }
        this.inputInbox.markCommitted(inputId);
        if (
          canSteerCurrentRequest &&
          priority === InputPriority.NOW &&
          this.executionState.phase === 'running'
        ) {
          activeController.interruptStep(inputId);
        }
      } catch (error) {
        this.inputInbox.remove(inputId);
        throw error;
      }
      return canSteerCurrentRequest
        ? {
            status: 'steered',
            inputId,
            requestId: activeRequestId,
            priority: priority === InputPriority.NOW ? InputPriority.NOW : InputPriority.NEXT,
          }
        : {
            status: 'queued',
            inputId,
            priority: InputPriority.LATER,
          };
    });
  }

  getPendingInputs(): readonly PendingSessionInput[] {
    return this.inputInbox.getAll();
  }

  async cancelInput(inputId: InputId): Promise<boolean> {
    await this.ensureInitialized();
    return this.inputMutex.runExclusive(async () => {
      if (this.executionLeaseFailure) {
        throw this.executionLeaseFailure;
      }
      if (this.executionState.phase === 'suspending' || this.executionState.phase === 'closed') {
        throw new Error('Session is closed');
      }
      if (
        (this.executionState.phase === 'running' || this.executionState.phase === 'stopping') &&
        this.executionState.controller.isInitialInput(inputId)
      ) {
        return false;
      }
      const input = this.inputInbox.claimForCancellation(inputId);
      if (!input) {
        return false;
      }

      const pendingState =
        this.executionState.phase === 'pending' && this.executionState.input.inputId === inputId
          ? this.executionState
          : null;
      let durablyInterrupted = false;
      if (pendingState) {
        const durableRecorder = await this.ensureDurableRecorder(pendingState);
        pendingState.durableRecorder = durableRecorder;
        if (durableRecorder) {
          await durableRecorder.finish({
            status: 'interrupted',
            reason: 'user_abort',
          });
          durablyInterrupted = true;
        }
      }
      try {
        await this.runWithExecutionLease(() =>
          this.getRuntime()
            .getContextManager()
            .saveInputCancelled(this.sessionId, inputId, 'cancelled_by_user'),
        );
      } catch (error) {
        if (!durablyInterrupted) {
          this.inputInbox.releaseClaim(inputId);
          throw error;
        }
        this.logger.warn(
          '[Session] Legacy input cancellation persistence failed after durable interruption:',
          error,
        );
      }
      this.inputInbox.remove(inputId);

      if (pendingState && this.executionState === pendingState) {
        pendingState.controller.dispose();
        this.executionState = { phase: 'idle' };
        this.scheduleNextQueuedInput();
      }
      return true;
    });
  }

  stream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    return this.consumeRequestStream(options);
  }

  private async *consumeRequestStream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    const channel = new SessionStreamChannel<SessionStreamEvent>(1);
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A consumer may abandon the stream after starting it. Keep the original
    // completion Promise awaitable by abort()/close() without an unhandled
    // rejection before either path observes it.
    void completion.catch(() => undefined);
    const execution: SessionStreamExecution = {
      completion,
      startedBeforeHandoff: !this.handoffRequested,
      releaseBackpressure: () => channel.releaseBackpressure(),
      isSettled: () => settled,
    };
    this.streamExecutions.add(execution);
    void completion.then(
      () => this.streamExecutions.delete(execution),
      () => this.streamExecutions.delete(execution),
    );
    const source = this.executeStream(options, execution);

    void (async () => {
      try {
        for await (const event of source) {
          await channel.publish(event);
        }
        settled = true;
        resolveCompletion();
        channel.close();
      } catch (error) {
        settled = true;
        rejectCompletion(error);
        channel.fail(error);
      }
    })();

    let consumedToEnd = false;
    try {
      for await (const event of channel) {
        yield event;
      }
      consumedToEnd = true;
    } finally {
      if (!consumedToEnd && !execution.isSettled()) {
        execution.releaseBackpressure();
        await this.abort();
      }
    }
  }

  private async *executeStream(
    options: StreamOptions | undefined,
    execution: SessionStreamExecution,
  ): AsyncGenerator<SessionStreamEvent> {
    try {
      await this.ensureInitialized();
    } catch (error) {
      if (execution.startedBeforeHandoff && this.handoffRequested) {
        return;
      }
      throw error;
    }
    const runtime = this.getRuntime();

    // 声明请求所有权必须原子：相位检查、pending→running 转换与初始输入移除
    // 需在 inputMutex 内一次完成，避免与 send()/cancelInput()/finishRequest()
    // 对 executionState 的并发读写交错。
    const claimed = await this.inputMutex.runExclusive(async () => {
      if (this.executionLeaseFailure) {
        throw this.executionLeaseFailure;
      }
      if (this.executionState.phase !== 'pending') {
        return null;
      }
      const pendingState = this.executionState;
      const {
        requestId,
        input,
        message: initialMessage,
        options: sendOptions,
        snapshot: pendingSnapshot,
        durableRecorder: pendingDurableRecorder,
        initialInputPreparation,
      } = this.executionState;
      const requestController = this.executionState.controller;
      const durableRecorder =
        pendingDurableRecorder ??
        (this.durableJournal
          ? new SessionDurableRecorder(this.durableJournal, requestId, this.options.model)
          : null);
      try {
        if (durableRecorder && !pendingDurableRecorder) {
          await durableRecorder.recordAccepted(
            input.inputId,
            input.content,
            input.priority === InputPriority.LATER ? 'later' : 'next',
            this.durableExecutionSnapshot(pendingState),
          );
        }
        await durableRecorder?.recordStarted(
          input.inputId,
          input.priority === InputPriority.LATER ? 'later' : 'next',
        );
      } catch (error) {
        requestController.dispose();
        this.inputInbox.remove(input.inputId);
        this.executionState = { phase: 'idle' };
        throw error;
      }
      this.executionState = {
        phase: 'running',
        requestId,
        controller: requestController,
        durableRecorder,
        execution,
      };
      // 提交执行后立即将初始输入移出收件箱：它已被应用，不再是待处理输入，
      // 且已通过 initialInputId 从 steering 领取中排除。若延后移除，一旦流在
      // 持久化 input_applied 之后、首个事件产出之前抛错，releaseRequest 会把它
      // 重新排队为 later 并二次应用，造成同一输入重复写入历史。
      this.inputInbox.remove(input.inputId);
      return {
        requestId,
        input,
        initialMessage,
        sendOptions,
        pendingSnapshot,
        requestController,
        durableRecorder,
        initialInputPreparation,
      };
    });

    if (!claimed) {
      if (execution.startedBeforeHandoff && this.handoffRequested) {
        return;
      }
      throw new Error('No pending message. Call send() before stream().');
    }

    const {
      requestId,
      input,
      initialMessage,
      sendOptions,
      pendingSnapshot,
      requestController,
      durableRecorder,
      initialInputPreparation,
    } = claimed;

    let durableFinishAttempted = false;
    let durableFinishCommitted = !durableRecorder;
    const finishDurableRequest = async (finish: DurableRequestFinish): Promise<void> => {
      if (!durableRecorder || durableFinishAttempted) {
        return;
      }
      durableFinishAttempted = true;
      if (!(await durableRecorder.finish(finish))) {
        throw new SessionDurableRecorderError(
          `Request ${requestId} has a tool outcome that requires reconciliation`,
        );
      }
      durableFinishCommitted = true;
    };
    let message = initialMessage;
    const traceRecorder = this.createTraceRecorder(message);
    let traceFinished = false;
    const finishTrace = async (
      status: 'success' | 'error' | 'aborted',
      data?: Record<string, unknown>,
    ) => {
      if (!traceRecorder || traceFinished) return;
      traceFinished = true;
      const trace = traceRecorder.finish(status, data);
      this.rememberTrace(trace);
      await this.notifyTraceSink(trace);
    };
    const signal = requestController.requestSignal;
    const isHandoffRequested = () => durableRecorder?.isHandoffRequested() === true;
    const releaseBackpressureOnAbort = () => execution.releaseBackpressure();
    if (signal.aborted) {
      releaseBackpressureOnAbort();
    } else {
      signal.addEventListener('abort', releaseBackpressureOnAbort, { once: true });
    }

    runtime.getHookRuntime().setTraceCollector(traceRecorder);
    try {
      if (initialInputPreparation !== RECONCILED_INITIAL_INPUT) {
        message = await runtime.getHookRuntime().applyUserPromptSubmit(message, {
          abortSignal: signal,
        });
      }
    } catch (error) {
      const handingOff = isHandoffRequested();
      const leaseFailure = this.executionLeaseFailure;
      const requestAborted = signal.aborted;
      const containmentFailure = isHookProcessContainmentError(error);
      let terminalError = error;
      if (!handingOff && !leaseFailure) {
        try {
          await finishDurableRequest(
            requestAborted && !containmentFailure
              ? {
                  status: 'interrupted',
                  reason: this.getDurableInterruptReason(requestController),
                }
              : { status: 'failed', error },
          );
        } catch (durableError) {
          terminalError = new AggregateError(
            [error, durableError],
            'Request setup and durable finalization both failed',
          );
        }
      }
      let errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      let terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      try {
        await finishTrace(
          !terminalContainmentFailure && (handingOff || leaseFailure || requestAborted)
            ? 'aborted'
            : 'error',
          {
            ...(terminalContainmentFailure
              ? { error: errorMessage }
              : handingOff
                ? { reason: 'session_handoff' }
                : leaseFailure
                  ? { reason: 'process_restart' }
                  : requestAborted
                    ? { reason: this.getDurableInterruptReason(requestController) }
                    : { error: errorMessage }),
          },
        );
      } catch (traceError) {
        const combinedError = new AggregateError(
          [terminalError, traceError],
          'Request setup and trace finalization both failed',
        );
        terminalError = combinedError;
        errorMessage = combinedError.message;
        terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      }
      try {
        if (terminalContainmentFailure) {
          throw terminalError;
        }
        if (handingOff) {
          return;
        }
        if (leaseFailure) {
          throw leaseFailure;
        }
        if (durableRecorder && !durableFinishCommitted) {
          throw terminalError;
        }
        if (requestAborted) {
          return;
        }
        yield { type: 'error', message: errorMessage, sessionId: this.sessionId };
      } finally {
        runtime.getHookRuntime().setTraceCollector(undefined);
        signal.removeEventListener('abort', releaseBackpressureOnAbort);
        // Keep execution ownership until the terminal event is consumed or
        // cancellation releases output backpressure.
        requestController.dispose();
        await this.finishRequest(requestId);
      }
      return;
    }

    const toolCalls: ToolExecutionRecord[] = [];
    let totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 0,
    };

    const snapshot =
      pendingSnapshot ??
      createContextSnapshot(this.sessionId, nanoid(), this.defaultContext, sendOptions?.context);
    runtime.prepareTurn(snapshot);
    const executionLease = this.executionLease;

    const context: ChatContext = {
      messages: this._messages,
      userId: 'sdk-user',
      sessionId: this.sessionId,
      snapshot,
      signal,
      permissionMode: this.permissionMode,
      executionFence: executionLease?.fence,
      assertExecutionLease: executionLease ? () => executionLease.assertActive() : undefined,
      runWithExecutionLease: executionLease
        ? (operation) => executionLease.runFenced(operation)
        : undefined,
      backgroundAgentManager: runtime.getBackgroundAgentManager(),
      confirmationHandler: this.confirmationHandler,
      omitEnvironment: this.hostProfile === SERVER_SESSION_HOST,
    };

    const stream = this.getAgent().streamChat(message, context, {
      maxTurns: sendOptions?.maxTurns ?? this.maxTurns,
      signal,
      inputApplication: {
        inputId: input.inputId,
        requestId,
      },
      runControl: requestController,
      inputApplicationLifecycle: durableRecorder ?? undefined,
      modelExecutionLifecycle: durableRecorder ?? undefined,
      toolExecutionLifecycle: durableRecorder ?? undefined,
      initialInputPreparation:
        initialInputPreparation === RECONCILED_INITIAL_INPUT ? RECONCILED_INITIAL_INPUT : undefined,
    });
    let agentStreamCompleted = false;

    try {
      let loopResult: LoopResult | undefined;
      const turnSpans = new Map<number, SpanId>();
      const toolSpans = new Map<string, SpanId>();

      while (true) {
        const next = await stream.next();
        if (this.executionLeaseFailure) {
          throw this.executionLeaseFailure;
        }
        if (signal.aborted) {
          const canObserveHandoffCompletion =
            isHandoffRequested() && (next.done || next.value.type === 'agent_end');
          if (
            !canObserveHandoffCompletion &&
            (!next.done || next.value.error?.type !== 'aborted')
          ) {
            return;
          }
        }
        const { value, done } = next;
        if (done) {
          loopResult = value;
          agentStreamCompleted = true;
          break;
        }
        await durableRecorder?.recordAgentEvent(value);
        switch (value.type) {
          case 'turn_start': {
            const spanId = traceRecorder?.recordTurnStart(value.turn, value.maxTurns);
            if (spanId) turnSpans.set(value.turn, spanId);
            yield { type: 'turn_start', turn: value.turn, sessionId: this.sessionId };
            break;
          }
          case 'turn_end':
            traceRecorder?.recordTurnEnd(turnSpans.get(value.turn), value.turn);
            turnSpans.delete(value.turn);
            yield { type: 'turn_end', turn: value.turn, sessionId: this.sessionId };
            break;
          case 'turn_interrupted':
            traceRecorder?.addEvent('turn_interrupted', {
              inputId: value.inputId,
              requestId: value.requestId,
              turn: value.turn,
            });
            yield {
              ...value,
              sessionId: this.sessionId,
            };
            break;
          case 'input_applied':
            traceRecorder?.addEvent('input_applied', {
              inputId: value.inputId,
              requestId: value.requestId,
              priority: value.priority,
              turn: value.turn,
            });
            yield {
              ...value,
              sessionId: this.sessionId,
            };
            break;
          case 'content_delta':
            traceRecorder?.addEvent('content_delta', { delta: value.delta });
            yield { type: 'content', delta: value.delta, sessionId: this.sessionId };
            break;
          case 'thinking_delta':
            traceRecorder?.addEvent('thinking_delta', { delta: value.delta });
            if (options?.includeThinking) {
              yield { type: 'thinking', delta: value.delta, sessionId: this.sessionId };
            }
            break;
          case 'content':
            traceRecorder?.addEvent('content', { content: value.content });
            yield { type: 'content', delta: value.content, sessionId: this.sessionId };
            break;
          case 'thinking':
            traceRecorder?.addEvent('thinking', { content: value.content });
            if (options?.includeThinking) {
              yield { type: 'thinking', delta: value.content, sessionId: this.sessionId };
            }
            break;
          case 'tool_start': {
            if (value.toolCall.type !== 'function') break;
            const input = this.safeParseJson(value.toolCall.function.arguments);
            toolCalls.push({
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              input,
              output: '',
              duration: 0,
            });
            const toolSpanId = traceRecorder?.recordToolStart(
              ToolUseId(value.toolCall.id),
              value.toolCall.function.name,
              input,
            );
            if (toolSpanId) {
              toolSpans.set(value.toolCall.id, toolSpanId);
            }
            yield {
              type: 'tool_use',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              input,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_progress': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_progress',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                progress: value.progress,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_progress',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              progress: value.progress,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_message': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_message',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                content: value.content,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_message',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              content: value.content,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_runtime_patch': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_runtime_patch',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                patch: value.patch,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_runtime_patch',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              patch: value.patch,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_context_patch': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_context_patch',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                patch: value.patch,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_context_patch',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              patch: value.patch,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_new_messages': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_new_messages',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                messages: value.messages,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_new_messages',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              messages: value.messages,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_permission_updates': {
            if (value.toolCall.type !== 'function') break;
            traceRecorder?.addEvent(
              'tool_permission_updates',
              {
                toolCallId: value.toolCall.id,
                name: value.toolCall.function.name,
                updates: value.updates,
              },
              toolSpans.get(value.toolCall.id),
            );
            yield {
              type: 'tool_permission_updates',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              updates: value.updates,
              sessionId: this.sessionId,
            };
            break;
          }
          case 'tool_result': {
            if (value.toolCall.type !== 'function') break;
            const record = toolCalls.find((tc) => tc.id === value.toolCall.id);
            if (record) {
              record.output = value.result.model;
              record.isError = value.result.status === 'error';
            }
            traceRecorder?.recordToolResult(
              toolSpans.get(value.toolCall.id),
              ToolUseId(value.toolCall.id),
              value.toolCall.function.name,
              value.result.model,
              value.result.status === 'error',
            );
            toolSpans.delete(value.toolCall.id);
            yield {
              type: 'tool_result',
              id: ToolUseId(value.toolCall.id),
              name: value.toolCall.function.name,
              output: value.result.model,
              display: value.result.display,
              isError: value.result.status === 'error',
              sessionId: this.sessionId,
            };
            break;
          }
          case 'token_usage':
            totalUsage = {
              inputTokens: value.usage.inputTokens,
              outputTokens: value.usage.outputTokens,
              totalTokens: value.usage.totalTokens,
              maxContextTokens: value.usage.maxContextTokens,
            };
            traceRecorder?.recordUsage(totalUsage);
            break;
          default:
            break;
        }
      }

      if (!loopResult) {
        throw new Error('Stream ended without result');
      }

      const isAborted = loopResult.error?.type === 'aborted';
      const shouldExit = loopResult.metadata?.shouldExitLoop;

      if (isHandoffRequested() && !loopResult.success && !shouldExit) {
        await finishTrace('aborted', { reason: 'session_handoff' });
        return;
      }

      if (!loopResult.success && !isAborted && !shouldExit) {
        const messageText = loopResult.error?.message || 'Unknown error';
        await finishDurableRequest({
          status: 'failed',
          error: messageText,
        });
        await finishTrace('error', { error: messageText });
        yield { type: 'error', message: messageText, sessionId: this.sessionId };
        return;
      }

      this._messages = context.messages;
      const imageCount = this.getImageCount(message);
      if (!signal.aborted) {
        await runtime.getHookRuntime().runTaskCompleted({
          taskId: this.sessionId,
          taskDescription: this.getTextContent(message),
          hasImages: imageCount > 0,
          imageCount,
          resultSummary: loopResult.finalMessage || '',
          success: loopResult.success,
          abortSignal: signal,
        });
      }
      await finishTrace(isAborted ? 'aborted' : 'success', {
        content: loopResult.finalMessage || '',
        usage: totalUsage,
        turnsCount: loopResult.metadata?.turnsCount,
        toolCallsCount: loopResult.metadata?.toolCallsCount,
        duration: loopResult.metadata?.duration,
      });
      await finishDurableRequest(
        durableRequestFinishFromLoopResult(
          loopResult,
          totalUsage,
          this.getDurableInterruptReason(requestController),
        ),
      );
      yield { type: 'usage', usage: totalUsage, sessionId: this.sessionId };
      yield {
        type: 'result',
        subtype: 'success',
        content: loopResult.finalMessage || '',
        sessionId: this.sessionId,
      };
    } catch (error) {
      const handingOff = isHandoffRequested();
      const leaseFailure = this.executionLeaseFailure;
      const requestAborted = signal.aborted;
      const containmentFailure = isHookProcessContainmentError(error);
      let terminalError = error;
      if (!handingOff && !leaseFailure && !durableFinishAttempted) {
        try {
          await finishDurableRequest(
            requestAborted && !containmentFailure
              ? {
                  status: 'interrupted',
                  reason: this.getDurableInterruptReason(requestController),
                }
              : { status: 'failed', error },
          );
        } catch (durableError) {
          terminalError = new AggregateError(
            [error, durableError],
            'Request execution and durable finalization both failed',
          );
        }
      }
      let errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      let terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      try {
        await finishTrace(
          !terminalContainmentFailure && (handingOff || leaseFailure || requestAborted)
            ? 'aborted'
            : 'error',
          {
            ...(terminalContainmentFailure
              ? { error: errorMessage }
              : handingOff
                ? { reason: 'session_handoff' }
                : leaseFailure
                  ? { reason: 'process_restart' }
                  : requestAborted
                    ? { reason: this.getDurableInterruptReason(requestController) }
                    : { error: errorMessage }),
          },
        );
      } catch (traceError) {
        const combinedError = new AggregateError(
          [terminalError, traceError],
          'Request execution and trace finalization both failed',
        );
        terminalError = combinedError;
        errorMessage = combinedError.message;
        terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      }
      if (terminalContainmentFailure) {
        throw terminalError;
      }
      if (handingOff) {
        return;
      }
      if (leaseFailure) {
        throw leaseFailure;
      }
      if (durableRecorder && !durableFinishCommitted) {
        throw terminalError;
      }
      if (requestAborted) {
        return;
      }
      yield { type: 'error', message: errorMessage, sessionId: this.sessionId };
    } finally {
      let cleanupError: unknown;
      if (!agentStreamCompleted) {
        requestController.abortRequest({ kind: 'user_abort' });
        try {
          await stream.return(undefined as never);
        } catch (error) {
          cleanupError = error;
        }
        try {
          await finishTrace('aborted', {
            reason: this.getDurableInterruptReason(requestController),
          });
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError(
                [cleanupError, error],
                'Agent stream cleanup and trace finalization both failed',
              )
            : error;
        }
        if (!isHandoffRequested() && !this.executionLeaseFailure) {
          try {
            if (!durableFinishAttempted) {
              await finishDurableRequest({
                status: 'interrupted',
                reason: this.getDurableInterruptReason(requestController),
              });
            }
          } catch (error) {
            cleanupError = cleanupError
              ? new AggregateError(
                  [cleanupError, error],
                  'Agent stream cleanup and durable finalization both failed',
                )
              : error;
          }
        }
      }
      runtime.getHookRuntime().setTraceCollector(undefined);
      signal.removeEventListener('abort', releaseBackpressureOnAbort);
      requestController.dispose();
      await this.finishRequest(requestId);
      if (
        this.executionState.phase === 'closed' &&
        this.executionState.disposition === 'terminal'
      ) {
        await this.closeDurableSession();
      }
      if (cleanupError) {
        await Promise.reject(cleanupError);
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const closePromise = this.handoffPromise
      ? this.handoffPromise.then(() => undefined)
      : this.closeInternal('terminal');
    this.closePromise = closePromise;
    void closePromise.catch(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = null;
      }
    });
    return closePromise;
  }

  suspendForHandoff(): Promise<SessionHandoffResult> {
    if (this.executionLeaseFailure) {
      return Promise.reject(this.executionLeaseFailure);
    }
    if (!this.options.durableEventStore) {
      return Promise.reject(
        new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Session handoff requires durableEventStore',
        ),
      );
    }
    if (!this.persistenceEnabled) {
      return Promise.reject(
        new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Session handoff requires persistent transcript storage',
        ),
      );
    }
    if (this.handoffPromise) {
      return this.handoffPromise;
    }
    if (this.closePromise) {
      return Promise.reject(
        new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session close has already started'),
      );
    }

    const handoffPromise = this.suspendForHandoffInternal();
    this.handoffRequested = true;
    this.handoffPromise = handoffPromise;
    void handoffPromise.catch(() => {
      if (this.handoffPromise === handoffPromise) {
        this.handoffPromise = null;
        if (this.executionState.phase !== 'suspending' && this.executionState.phase !== 'closed') {
          this.handoffRequested = false;
        }
      }
    });
    return handoffPromise;
  }

  async disposeAfterFork(): Promise<void> {
    await this.closeInternal('detached');
  }

  private async closeInternal(
    disposition: 'terminal' | 'detached',
    abortReason: RequestAbortReason = { kind: 'session_close' },
  ): Promise<void> {
    this.runtime?.assertNoPendingCleanup({ includeTerminalFailures: false });
    const recordDurableClose = disposition === 'terminal';
    // 关闭时对 executionState 的读写走 inputMutex，避免与并发 send()/stream()
    // 交错（例如 send() 在 await 处让出后用 pending 覆盖 closed）。
    const closeState = await this.inputMutex.runExclusive(async () => {
      if (this.executionState.phase === 'closed') {
        this.executionState.execution?.releaseBackpressure();
        return {
          alreadyClosed: true,
          disposition: this.executionState.disposition,
          execution: this.executionState.execution,
        };
      }
      let execution: SessionStreamExecution | undefined;
      if (this.executionState.phase === 'pending') {
        const { controller, input } = this.executionState;
        if (recordDurableClose) {
          const durableRecorder = await this.ensureDurableRecorder(this.executionState);
          this.executionState.durableRecorder = durableRecorder;
          await durableRecorder?.finish({
            status: 'interrupted',
            reason: 'session_close',
          });
        }
        controller.abortRequest(abortReason);
        controller.dispose();
        this.inputInbox.remove(input.inputId);
      } else if (
        this.executionState.phase === 'running' ||
        this.executionState.phase === 'stopping' ||
        this.executionState.phase === 'suspending'
      ) {
        if (this.executionState.phase !== 'suspending') {
          this.executionState.controller.abortRequest(abortReason);
        }
        execution = this.executionState.execution;
        execution.releaseBackpressure();
      }
      this.executionState = {
        phase: 'closed',
        disposition,
        ...(execution ? { execution } : {}),
      };
      return {
        alreadyClosed: false,
        disposition,
        execution,
      };
    });

    const closeErrors: unknown[] = [];
    if (closeState.execution) {
      try {
        await closeState.execution.completion;
      } catch (error) {
        closeErrors.push(error);
      }
      await this.inputMutex.runExclusive(() => {
        if (
          this.executionState.phase === 'closed' &&
          this.executionState.execution === closeState.execution
        ) {
          this.executionState = {
            phase: 'closed',
            disposition: closeState.disposition,
          };
        }
      });
    }

    this.runtime?.assertNoPendingCleanup({ includeTerminalFailures: false });
    if (this.runtime) {
      closeErrors.push(...(await this.releaseLocalRuntime()));
    }
    if (recordDurableClose && closeState.disposition === 'terminal') {
      try {
        await this.closeDurableSession();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (!this.runtime && (closeErrors.length === 0 || this.executionLeaseFailure)) {
      try {
        await this.releaseExecutionLease();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (!closeState.alreadyClosed) {
      this.logger.debug(`[Session] Closed session ${this.sessionId}`);
    }
    if (closeErrors.length === 1) {
      throw closeErrors[0];
    }
    if (closeErrors.length > 1) {
      throw new AggregateError(closeErrors, 'Session close failed in multiple phases');
    }
  }

  private async suspendForHandoffInternal(): Promise<SessionHandoffResult> {
    if (!this.initialized) {
      throw new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session is not initialized');
    }
    const runtime = this.getRuntime();
    runtime.assertNoPendingCleanup();
    const journal = this.durableJournal;
    if (!journal) {
      throw new SessionHandoffError(
        'SESSION_HANDOFF_NOT_CONFIGURED',
        'Session handoff requires durableEventStore',
      );
    }

    const handoffState = await this.inputMutex.runExclusive(() => {
      if (this.executionState.phase === 'closed') {
        throw new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session is already closed');
      }
      if (this.executionState.phase === 'stopping') {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_UNAVAILABLE',
          'Session request cancellation has already started',
        );
      }

      const durableRecorder =
        this.executionState.phase === 'pending' ||
        this.executionState.phase === 'running' ||
        this.executionState.phase === 'suspending'
          ? this.executionState.durableRecorder
          : null;
      if (
        (this.executionState.phase === 'pending' ||
          this.executionState.phase === 'running' ||
          this.executionState.phase === 'suspending') &&
        !durableRecorder
      ) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Active Session handoff requires a durable Request recorder',
        );
      }
      durableRecorder?.assertHandoffReady();

      const blockers = runtime.sealBackgroundWorkForHandoff(this.executionLease?.fence);
      if (blockers.activeSubagentIds.length > 0 || blockers.activeShellIds.length > 0) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_ACTIVE_WORK',
          'Session handoff requires all background work to settle first',
          blockers,
        );
      }

      if (this.executionState.phase === 'suspending') {
        return {
          durableRecorder,
          executions: [...this.streamExecutions],
        };
      }
      if (this.executionState.phase === 'running') {
        const { requestId, controller, execution } = this.executionState;
        if (!durableRecorder) {
          throw new SessionHandoffError(
            'SESSION_HANDOFF_NOT_CONFIGURED',
            'Running Session handoff requires a durable Request recorder',
          );
        }
        durableRecorder.beginHandoff();
        controller.abortRequest({ kind: 'session_handoff' });
        execution.releaseBackpressure();
        this.executionState = {
          phase: 'suspending',
          requestId,
          controller,
          durableRecorder,
          execution,
        };
        const executions = [...this.streamExecutions];
        for (const activeExecution of executions) {
          activeExecution.releaseBackpressure();
        }
        return { durableRecorder, executions };
      }

      if (this.executionState.phase === 'pending') {
        durableRecorder?.beginHandoff();
        this.executionState.controller.abortRequest({ kind: 'session_handoff' });
        this.executionState.controller.dispose();
      }
      this.executionState = {
        phase: 'closed',
        disposition: 'detached',
      };
      const executions = [...this.streamExecutions];
      for (const activeExecution of executions) {
        activeExecution.releaseBackpressure();
      }
      return {
        durableRecorder,
        executions,
      };
    });

    const handoffErrors: unknown[] = [];
    const executionResults = await Promise.allSettled(
      handoffState.executions.map((execution) => execution.completion),
    );
    for (const result of executionResults) {
      if (result.status === 'rejected') {
        handoffErrors.push(result.reason);
      }
    }
    runtime.assertNoPendingCleanup();
    if (handoffState.durableRecorder) {
      try {
        await handoffState.durableRecorder.finalizeHandoff();
      } catch (error) {
        handoffErrors.push(error);
      }
    }

    await this.inputMutex.runExclusive(() => {
      if (this.executionState.phase === 'suspending') {
        this.executionState = {
          phase: 'closed',
          disposition: 'detached',
        };
      }
    });
    handoffErrors.push(...(await this.releaseLocalRuntime()));

    let recoveryPlan: DurableSessionRecoveryPlan | null = null;
    let headSequence: EventSequence | null = null;
    try {
      const projection = await journal.refresh();
      if (projection.status !== 'open' || projection.headSequence === null) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_UNAVAILABLE',
          `Durable Session ${this.sessionId} is not open after handoff`,
        );
      }
      headSequence = projection.headSequence;
      recoveryPlan = journal.getRecoveryPlan();
    } catch (error) {
      handoffErrors.push(error);
    }
    if (!this.runtime && (handoffErrors.length === 0 || this.executionLeaseFailure)) {
      try {
        await this.releaseExecutionLease();
      } catch (error) {
        handoffErrors.push(error);
      }
    }

    if (handoffErrors.length === 1) {
      throw handoffErrors[0];
    }
    if (handoffErrors.length > 1) {
      throw new AggregateError(handoffErrors, 'Session handoff failed in multiple phases');
    }
    if (!recoveryPlan || headSequence === null) {
      throw new SessionHandoffError(
        'SESSION_HANDOFF_UNAVAILABLE',
        'Session handoff did not produce a durable recovery frontier',
      );
    }

    this.logger.debug(`[Session] Suspended session ${this.sessionId} for handoff`);
    return {
      sessionId: this.sessionId,
      headSequence,
      recoveryPlan,
    };
  }

  private async releaseLocalRuntime(): Promise<unknown[]> {
    const errors: unknown[] = [];
    this.cleanupHandle?.unregister();
    this.cleanupHandle = null;
    this.agent = null;
    this.initialized = false;
    const runtime = this.runtime;
    const executionFence = this.executionLease?.fence;
    if (runtime) {
      let runtimeClosed = false;
      if (!this.runtimeEndAttempted) {
        try {
          await runtime.getHookRuntime().runSessionEnd({ reason: 'other' });
          this.runtimeEndAttempted = true;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await runtime.close(executionFence);
        runtimeClosed = true;
      } catch (error) {
        errors.push(error);
      }
      if (this.runtimeEndAttempted && runtimeClosed && this.runtime === runtime) {
        this.runtime = null;
      }
    }
    return errors;
  }

  private async initializeExecutionLease(): Promise<void> {
    const options = this.options.executionLease;
    if (!options || this.executionLease) {
      return;
    }
    if (!this.persistenceEnabled) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Session execution leases require persistent transcript storage',
        { sessionId: this.sessionId },
      );
    }
    const store = this.options.durableEventStore;
    if (!store) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED',
        'Session execution leases require durableEventStore',
        { sessionId: this.sessionId },
      );
    }
    this.executionLease = await DurableExecutionLease.acquire(store, this.sessionId, {
      ...options,
      storeTimeoutMs: Math.min(
        options.storeTimeoutMs ?? this.durableStoreTimeoutMs,
        this.durableStoreTimeoutMs,
      ),
    });
  }

  private runWithExecutionLease<T>(operation: () => Promise<T>): Promise<T> {
    return this.executionLease ? this.executionLease.runFenced(operation) : operation();
  }

  private async releaseExecutionLease(): Promise<void> {
    const lease = this.executionLease;
    await lease?.release();
    if (this.executionLease === lease) {
      this.executionLeaseLossCleanup?.();
      this.executionLeaseLossCleanup = null;
      this.executionLease = null;
    }
  }

  private handleExecutionLeaseLoss(error: DurableExecutionLeaseError): void {
    if (this.executionLeaseFailure) {
      return;
    }
    this.executionLeaseFailure = error;
    const state = this.executionState;
    if (state.phase === 'pending') {
      state.controller.abortRequest({
        kind: 'execution_lease_lost',
        cause: error,
      });
    } else if (
      state.phase === 'running' ||
      state.phase === 'stopping' ||
      state.phase === 'suspending'
    ) {
      state.controller.abortRequest({
        kind: 'execution_lease_lost',
        cause: error,
      });
      state.execution.releaseBackpressure();
    }
    const executionFence = this.executionLease?.fence;
    if (executionFence) {
      this.runtime?.stopBackgroundWorkAfterLeaseLoss(executionFence);
    }
    if (!this.initialized || this.handoffPromise || this.closePromise) {
      return;
    }

    const cleanup = this.closeInternal('detached', {
      kind: 'execution_lease_lost',
      cause: error,
    });
    this.closePromise = cleanup;
    void cleanup.catch((cleanupError: unknown) => {
      this.logger.error(
        `[Session] Failed to clean up after execution lease loss for ${this.sessionId}`,
        cleanupError,
      );
      if (this.closePromise === cleanup) {
        this.closePromise = null;
      }
    });
  }

  async abort(): Promise<void> {
    if (this.handoffPromise) {
      await this.handoffPromise;
      return;
    }
    const result = await this.inputMutex.runExclusive(async () => {
      if (this.executionState.phase === 'running') {
        const { requestId, controller, durableRecorder, execution } = this.executionState;
        controller.abortRequest({ kind: 'user_abort' });
        execution.releaseBackpressure();
        this.executionState = {
          phase: 'stopping',
          requestId,
          controller,
          durableRecorder,
          execution,
        };
        return { completion: execution.completion };
      } else if (this.executionState.phase === 'stopping') {
        this.executionState.execution.releaseBackpressure();
        return { completion: this.executionState.execution.completion };
      } else if (this.executionState.phase === 'suspending') {
        this.executionState.execution.releaseBackpressure();
        return { completion: this.executionState.execution.completion };
      } else if (this.executionState.phase === 'pending') {
        const pendingState = this.executionState;
        const durableRecorder = await this.ensureDurableRecorder(pendingState);
        pendingState.durableRecorder = durableRecorder;
        await durableRecorder?.finish({
          status: 'interrupted',
          reason: 'user_abort',
        });
        pendingState.controller.abortRequest({ kind: 'user_abort' });
        const { controller, input } = pendingState;
        controller.dispose();
        this.inputInbox.remove(input.inputId);
        this.executionState = { phase: 'idle' };
        this.scheduleNextQueuedInput();
      }
      return { completion: null };
    });
    if (result.completion) {
      await result.completion;
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  async setModel(model: string): Promise<void> {
    await this.ensureInitialized();
    await this.getAgent().setModel(model);
    this.options.model = model;
    this.logger.debug(`[Session] Updated model to ${model}`);
  }

  setMaxTurns(maxTurns: number): void {
    this.maxTurns = maxTurns;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'default',
        name: this.options.model,
        provider: this.options.provider.id?.trim() || this.options.provider.type,
      },
    ];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    await this.ensureInitialized();
    return this.getRuntime().mcpServerStatus();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.ensureInitialized();
    await this.getRuntime().mcpConnect(serverName);
    this.logger.debug(`[Session] Connected to MCP server: ${serverName}`);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.ensureInitialized();
    await this.getRuntime().mcpDisconnect(serverName);
    this.logger.debug(`[Session] Disconnected from MCP server: ${serverName}`);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.ensureInitialized();
    await this.getRuntime().mcpReconnect(serverName);
    this.logger.debug(`[Session] Reconnected to MCP server: ${serverName}`);
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    return this.getRuntime().mcpListTools();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.executionLeaseFailure) {
      throw this.executionLeaseFailure;
    }
    if (
      this.handoffRequested ||
      this.executionState.phase === 'suspending' ||
      this.executionState.phase === 'closed'
    ) {
      throw new Error('Session is closed');
    }
    if (!this.initialized) {
      await this.initialize();
      return;
    }
    await this.executionLease?.assertActive();
  }

  private getAgent(): Agent {
    if (!this.agent) {
      throw new Error('Session agent is not initialized');
    }
    return this.agent;
  }

  private getRuntime(): SessionRuntime {
    if (!this.runtime) {
      throw new Error('Session runtime is not initialized');
    }
    return this.runtime;
  }

  private async initializeDurableJournal(): Promise<void> {
    if (this.durableJournal) {
      return;
    }
    const eventStore = this.options.durableEventStore;
    if (!eventStore) {
      return;
    }

    const journal = await DurableSessionJournal.open(eventStore, this.sessionId, {
      ...(this.executionLease ? { executionLease: this.executionLease } : {}),
      storeTimeoutMs: this.durableStoreTimeoutMs,
    });
    const projection = journal.getProjection();
    if (projection.status === 'empty') {
      await journal.commit({
        commandId: CommandId(nanoid()),
        events: [
          {
            type: DurableEventType.SESSION_CREATED,
            data: {
              source: this.durableOrigin.source,
              ...(this.durableOrigin.parentSessionId
                ? { parentSessionId: this.durableOrigin.parentSessionId }
                : {}),
            },
          },
        ],
      });
      this.durableJournal = journal;
      return;
    }
    if (!this.isResumeSession) {
      throw new SessionDurableRecorderError(`Durable Session ${this.sessionId} already exists`);
    }
    if (projection.status === 'closed') {
      throw new SessionDurableRecorderError(`Durable Session ${this.sessionId} is closed`);
    }
    const resumeDecision = new DurableSessionRecoveryCoordinator(journal).planResume();
    if (resumeDecision.action === 'recovery_required') {
      throw new DurableSessionRecoveryRequiredError(resumeDecision.recoveryPlan);
    }
    if (resumeDecision.action === 'resume_accepted_request') {
      this.durableAcceptedRequest = resumeDecision.request;
      this.options.model = resumeDecision.request.model;
    }
    this.durableJournal = journal;
  }

  private async ensureDurableRecorder(
    pendingState: Extract<SessionExecutionState, { phase: 'pending' }>,
  ): Promise<SessionDurableRecorder | null> {
    if (pendingState.durableRecorder || !this.durableJournal) {
      return pendingState.durableRecorder;
    }
    const recorder = new SessionDurableRecorder(
      this.durableJournal,
      pendingState.requestId,
      this.options.model,
    );
    await recorder.recordAccepted(
      pendingState.input.inputId,
      pendingState.input.content,
      pendingState.input.priority === InputPriority.LATER ? 'later' : 'next',
      this.durableExecutionSnapshot(pendingState),
    );
    return recorder;
  }

  private async closeDurableSession(): Promise<void> {
    if (this.durableClosePromise) {
      return this.durableClosePromise;
    }
    const journal = this.durableJournal;
    if (!journal) {
      return;
    }
    const projection = journal.getProjection();
    if (projection.status !== 'open' || projection.activeRequest) {
      return;
    }
    const closePromise = journal
      .commit({
        commandId: CommandId(nanoid()),
        events: [
          {
            type: DurableEventType.SESSION_CLOSED,
            data: { reason: 'shutdown' },
          },
        ],
      })
      .then(() => undefined);
    this.durableClosePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      if (this.durableClosePromise === closePromise) {
        this.durableClosePromise = null;
      }
      throw error;
    }
  }

  private assertDurableReadyForNewRequest(): void {
    const recoveryPlan = this.durableJournal?.getRecoveryPlan();
    if (recoveryPlan && recoveryPlan.action !== 'none') {
      throw new DurableSessionRecoveryRequiredError(recoveryPlan);
    }
  }

  private getDurableInterruptReason(
    controller: ActiveRequestController,
  ): DurableRequestInterruptReason {
    const reason = controller.requestSignal.reason as RequestAbortReason | undefined;
    if (reason?.kind === 'session_close') {
      return 'session_close';
    }
    if (reason?.kind === 'session_handoff') {
      return 'process_restart';
    }
    if (reason?.kind === 'execution_lease_lost') {
      return 'process_restart';
    }
    return 'user_abort';
  }

  private async finishRequest(requestId: RequestId): Promise<void> {
    await this.inputMutex.runExclusive(() => {
      if (
        (this.executionState.phase !== 'running' && this.executionState.phase !== 'stopping') ||
        this.executionState.requestId !== requestId
      ) {
        return;
      }

      this.inputInbox.releaseRequest(requestId);
      this.executionState = { phase: 'idle' };
      this.scheduleNextQueuedInput();
    });
  }

  private createPendingState(
    requestId: RequestId,
    input: PendingSessionInput,
    options?: SendOptions,
    durableRecorder: SessionDurableRecorder | null = null,
    snapshot?: ContextSnapshot,
    initialInputPreparation?: InitialInputPreparation,
  ): Extract<SessionExecutionState, { phase: 'pending' }> {
    return {
      phase: 'pending',
      requestId,
      input,
      controller: new ActiveRequestController(
        requestId,
        options?.signal,
        this.inputInbox,
        input.inputId,
      ),
      message: input.content,
      options: options || null,
      durableRecorder,
      initialInputPreparation,
      snapshot:
        snapshot ??
        createContextSnapshot(this.sessionId, nanoid(), this.defaultContext, options?.context),
    };
  }

  private durableExecutionSnapshot(state: Extract<SessionExecutionState, { phase: 'pending' }>): {
    maxTurns: number;
    context: JsonObject;
  } {
    return {
      maxTurns: state.options?.maxTurns ?? this.maxTurns,
      context: serializeDurableRuntimeContext(state.snapshot.context),
    };
  }

  private restoreDurableAcceptedRequest(request: DurableRequestProjection): void {
    if (this.executionState.phase !== 'idle') {
      throw new SessionDurableRecorderError(
        `Cannot restore request ${request.requestId} while Session is ${this.executionState.phase}`,
      );
    }
    const content = parseDurableUserMessageContent(request.input);
    const acceptedAt = Date.parse(request.acceptedAt);
    const input: PendingSessionInput = {
      inputId: request.inputId,
      content,
      priority: request.priority === InputPriority.LATER ? InputPriority.LATER : InputPriority.NEXT,
      targetRequestId: request.requestId,
      acceptedAt: Number.isFinite(acceptedAt) ? acceptedAt : Date.now(),
    };
    this.inputInbox.remove(input.inputId);
    this.inputInbox.enqueue(input);

    const recoveredContext = parseDurableRuntimeContext(request.context) ?? this.defaultContext;
    const snapshot = createContextSnapshot(this.sessionId, nanoid(), recoveredContext);
    const sendOptions: SendOptions = {
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    };
    const recorder = this.durableJournal
      ? new SessionDurableRecorder(this.durableJournal, request.requestId, this.options.model)
      : null;
    this.executionState = this.createPendingState(
      request.requestId,
      input,
      sendOptions,
      recorder,
      snapshot,
      request.recoveryKind === 'pre_turn_request' ? RECONCILED_INITIAL_INPUT : undefined,
    );
    this.durableAcceptedRequest = null;
  }

  private scheduleNextQueuedInput(): void {
    if (this.executionState.phase !== 'idle') {
      return;
    }
    if (this.durableJournal && this.durableJournal.getRecoveryPlan().action !== 'none') {
      return;
    }
    const requestId = RequestId(nanoid());
    const input = this.inputInbox.claimNextLater(requestId);
    if (!input) {
      return;
    }
    this.executionState = this.createPendingState(requestId, input);
  }

  private async persistInput(input: PendingSessionInput): Promise<void> {
    await this.runWithExecutionLease(() =>
      this.getRuntime()
        .getContextManager()
        .saveInputEnqueued(this.sessionId, {
          inputId: input.inputId,
          content: input.content as JsonValue,
          priority: input.priority,
          targetRequestId: input.targetRequestId,
          acceptedAt: input.acceptedAt,
        }),
    );
  }

  private safeParseJson(str: string): JsonValue {
    try {
      return JSON.parse(str) as JsonValue;
    } catch {
      return str;
    }
  }

  private createTraceRecorder(message: UserMessageContent): TraceRecorder | undefined {
    const observability = this.options.observability;
    if (!observability?.enabled) {
      return undefined;
    }
    const recorder = new TraceRecorder(this.sessionId, observability, {
      model: this.options.model,
      provider: this.options.provider.id?.trim() || this.options.provider.type,
      permissionMode: this.permissionMode,
    });
    recorder.addEvent('user_prompt', {
      message,
    });
    return recorder;
  }

  private rememberTrace(trace: AgentTrace): void {
    this.traces.push(trace);
    const maxTraces = this.options.observability?.maxTraces ?? 20;
    while (this.traces.length > maxTraces) {
      this.traces.shift();
    }
  }

  private async notifyTraceSink(trace: AgentTrace): Promise<void> {
    try {
      await this.options.observability?.sink?.(trace);
    } catch (error) {
      this.logger.warn('[Session] Observability trace sink failed:', error);
    }
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    await this.ensureInitialized();
    const snapshot = this.persistenceEnabled
      ? await this.runWithExecutionLease(() =>
          this.store.forkState(this.sessionId, {
            messageId: options?.messageId,
          }),
        )
      : this.createSnapshotFromMessages(options?.messageId);

    const forkedSession = new Session(
      {
        ...this.options,
        defaultContext: this.defaultContext,
      },
      undefined,
      false,
      this.hostProfile,
      {
        source: 'fork',
        parentSessionId: this.sessionId,
      },
    );
    await forkedSession.initialize();
    forkedSession._messages = this.cloneSnapshotMessages(snapshot);

    this.logger.debug(
      `[Session] Forked session ${this.sessionId} -> ${forkedSession.sessionId} with ${forkedSession._messages.length} messages`,
    );

    return forkedSession;
  }

  private cloneSnapshotMessages(snapshot: SessionSnapshot | null): ModelMessage[] {
    if (!snapshot) {
      return [];
    }

    return snapshot.messages.map(cloneMessage);
  }

  private createSnapshotFromMessages(messageId?: MessageId): SessionSnapshot {
    let messages = this._messages.map(cloneMessage);

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

  private getTextContent(message: UserMessageContent): string {
    if (typeof message === 'string') {
      return message;
    }

    return message
      .filter((part): part is Extract<ModelContent, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  private getImageCount(message: UserMessageContent): number {
    if (typeof message === 'string') {
      return 0;
    }

    return message.filter((part) => part.type === 'image_url').length;
  }
}

export async function createSession(options: SessionOptions): Promise<ISession> {
  return createSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function createSessionWithHost(
  options: SessionOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  const session = new Session(options, undefined, false, hostProfile);
  await session.initialize();
  return session;
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  return resumeSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function resumeSessionWithHost(
  options: ResumeOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  if (options.persistSession === false || !hasSessionPersistence(options)) {
    throw new Error(
      'resumeSession() requires session persistence through ' +
        'sessionRepository and sessionEventStore.',
    );
  }
  const { sessionId, ...sessionOptions } = options;
  const session = new Session(sessionOptions, sessionId, true, hostProfile);
  try {
    await session.initialize();
    await session.loadHistory();
    return session;
  } catch (error) {
    await session.disposeAfterFork();
    throw error;
  }
}

export interface ForkOptions extends ResumeOptions {
  messageId?: MessageId;
}

export async function forkSession(options: ForkOptions): Promise<ISession> {
  return forkSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function forkSessionWithHost(
  options: ForkOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  if (options.persistSession === false || !hasSessionPersistence(options)) {
    throw new Error(
      'forkSession() requires session persistence through ' +
        'sessionRepository and sessionEventStore. ' +
        'Use session.fork() for an in-memory Session.',
    );
  }
  const { sessionId, messageId, ...sessionOptions } = options;

  const sourceSession = new Session(sessionOptions, sessionId, true, hostProfile);
  await sourceSession.initialize();
  await sourceSession.loadHistory();

  try {
    return await sourceSession.fork({ messageId });
  } finally {
    await sourceSession.disposeAfterFork();
  }
}

export async function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return promptWithHost(message, options, SERVER_SESSION_HOST);
}

export async function promptWithHost(
  message: UserMessageContent,
  options: SessionOptions,
  hostProfile: SessionHostProfile,
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = new Session(options, undefined, false, hostProfile);
  await session.initialize();

  const toolCalls: ToolExecutionRecord[] = [];
  let totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxContextTokens: 0,
  };
  let turnsCount = 0;
  let result = '';
  let errorMessage: string | null = null;

  try {
    await session.send(message);

    for await (const msg of session.stream()) {
      if (msg.type === 'turn_start') {
        turnsCount = msg.turn;
      } else if (msg.type === 'tool_use') {
        toolCalls.push({
          id: msg.id,
          name: msg.name,
          input: msg.input,
          output: '',
          duration: 0,
        });
      } else if (msg.type === 'tool_result') {
        const record = toolCalls.find((tc) => tc.id === msg.id);
        if (record) {
          record.output = msg.output;
          record.isError = msg.isError;
        }
      } else if (msg.type === 'usage') {
        totalUsage = msg.usage;
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        result = msg.content || '';
      } else if (msg.type === 'error') {
        errorMessage = msg.message;
      } else if (msg.type === 'result' && msg.subtype === 'error') {
        errorMessage = msg.error || 'Unknown error';
      }
    }

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    return {
      result,
      toolCalls,
      usage: totalUsage,
      duration: Date.now() - startTime,
      turnsCount,
    };
  } finally {
    await session.close();
  }
}
