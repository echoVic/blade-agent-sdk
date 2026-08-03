import { nanoid } from 'nanoid';
import { Agent } from '../agent/Agent.js';
import type { UserMessageContent } from '../agent/types.js';
import { type CleanupHandle, registerCleanup } from '../lifecycle/CleanupRegistry.js';
import { createRootLogger, type InternalLogger, LogCategory } from '../logging/Logger.js';
import { type AgentTrace, TraceRecorder } from '../observability/index.js';
import {
  type ContextSnapshot,
  createContextSnapshot,
  type RuntimeContext,
} from '../runtime/index.js';
import type { ContentPart, Message } from '@blade-ai/ai/chat';
import { cloneMessage } from '../runtime/messageUtils.js';
import { isJsonObject, isSessionToolCall, isSessionToolCallArray, SessionId, type SessionSnapshot } from '@blade-ai/agent-sdk/local';
import {
  type BladeConfig,
  type JsonObject,
  type ModelConfig,
  PermissionMode,
  type ProviderType,
} from '../types/common.js';
import { SessionRuntime } from './SessionRuntime.js';
import {
  JsonlSessionStore,
  NoopSessionStore,
  type SessionStore,
} from './SessionStore.js';
import type {
  ForkSessionOptions,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PromptResult,
  ProviderConfig,
  SendOptions,
  SessionOptions,
  StreamMessage,
  StreamOptions,
  TokenUsage,
  ToolCallRecord,
} from './types.js';

export interface ResumeOptions extends SessionOptions {
  sessionId: SessionId;
}

class Session implements ISession {
  readonly sessionId: SessionId;
  private agent: Agent | null = null;
  private runtime: SessionRuntime | null = null;
  private abortController: AbortController | null = null;
  private _messages: Message[] = [];
  private readonly options: SessionOptions;
  private readonly store: SessionStore;
  private readonly persistenceEnabled: boolean;
  private readonly isResumeSession: boolean;
  private readonly rootLogger: InternalLogger;
  private readonly logger: InternalLogger;
  private maxTurns: number;
  private permissionMode: PermissionMode;
  private defaultContext: RuntimeContext;
  private initialized = false;
  private closed = false;
  private cleanupHandle: CleanupHandle | null = null;
  private readonly traces: AgentTrace[] = [];

  private pendingMessage: UserMessageContent | null = null;
  private pendingSendOptions: SendOptions | null = null;
  private pendingContextSnapshot: ContextSnapshot | null = null;

  constructor(options: SessionOptions, sessionId?: SessionId, isResume = false) {
    this.sessionId = sessionId || SessionId(nanoid());
    this.options = options;
    this.maxTurns = options.maxTurns ?? 200;
    this.permissionMode = options.permissionMode ?? PermissionMode.DEFAULT;
    this.defaultContext = options.defaultContext ?? {};
    this.persistenceEnabled = options.persistSession ?? true;
    this.store =
      this.persistenceEnabled && options.storagePath
        ? new JsonlSessionStore(options.storagePath)
        : new NoopSessionStore();
    this.isResumeSession = isResume;
    this.rootLogger = createRootLogger(options.logger, this.sessionId);
    this.logger = this.rootLogger.child(LogCategory.AGENT);
  }

  get messages(): Message[] {
    return [...this._messages];
  }

  get isClosed(): boolean {
    return this.closed;
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

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = this.buildBladeConfig();
    this.runtime = new SessionRuntime(
      this.sessionId,
      this.options,
      config,
      this.permissionMode,
      this.defaultContext,
      this.rootLogger,
    );
    await this.runtime.initialize();
    if (this.isResumeSession) {
      await this.runtime.ensureSessionLoaded();
    } else {
      await this.runtime.ensureSessionCreated();
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
      },
      this.runtime.getAgentRuntimeDeps(),
    );

    this.initialized = true;
    this.cleanupHandle = registerCleanup(() => this.close());
    await this.runtime.getHookRuntime().runSessionStart({
      isResume: this.isResumeSession,
      resumeSessionId: this.isResumeSession ? this.sessionId : undefined,
    });

    this.logger.debug(`[Session] Initialized session ${this.sessionId}`);
  }

  async loadHistory(): Promise<void> {
    try {
      const state = await this.store.loadState(this.sessionId);
      this._messages = state?.messages ?? [];
      if (this._messages.length === 0) {
        this.logger.debug(`[Session] No history found for session ${this.sessionId}`);
        return;
      }
      this.logger.debug(`[Session] Loaded ${this._messages.length} messages from history`);
    } catch (error) {
      this.logger.warn(`[Session] Failed to load history for session ${this.sessionId}:`, error);
    }
  }

  private buildBladeConfig(): BladeConfig {
    const modelConfig = this.buildModelConfig();

    return {
      models: [modelConfig],
      currentModelId: modelConfig.id,
      temperature: this.options.temperature ?? 0.7,
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
      provider: this.mapProviderType(provider.type),
      model: this.options.model,
      apiKey: provider.apiKey || '',
      baseUrl: provider.baseUrl || this.getDefaultBaseUrl(provider.type),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      maxContextTokens: this.options.maxContextTokens ?? 128000,
      maxOutputTokens: this.options.maxOutputTokens,
      temperature: this.options.temperature,
      providerOptions: this.options.providerOptions,
      thinkingEnabled: this.options.thinkingEnabled,
      thinkingBudget: this.options.thinkingBudget,
    };
  }

  private mapProviderType(type: ProviderConfig['type']): ProviderType {
    const mapping: Record<string, ProviderType> = {
      openai: 'openai',
      'openai-compatible': 'openai-compatible',
      anthropic: 'anthropic',
      gemini: 'gemini',
      deepseek: 'deepseek',
      'azure-openai': 'azure-openai',
    };
    return mapping[type] || 'openai-compatible';
  }

  private getDefaultBaseUrl(type: ProviderConfig['type']): string {
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

  async send(message: UserMessageContent, options?: SendOptions): Promise<void> {
    await this.ensureInitialized();

    if (this.pendingMessage !== null) {
      throw new Error(
        'Cannot send a new message while a previous message is pending. Call stream() first.',
      );
    }

    this.pendingMessage = message;
    this.pendingSendOptions = options || null;
    this.pendingContextSnapshot = createContextSnapshot(
      this.sessionId,
      nanoid(),
      this.defaultContext,
      options?.context,
    );
  }

  async *stream(options?: StreamOptions): AsyncGenerator<StreamMessage> {
    await this.ensureInitialized();
    const runtime = this.getRuntime();

    if (this.pendingMessage === null) {
      throw new Error('No pending message. Call send() before stream().');
    }

    const message = this.pendingMessage;
    const sendOptions = this.pendingSendOptions;
    const pendingSnapshot = this.pendingContextSnapshot;
    this.pendingMessage = null;
    this.pendingSendOptions = null;
    this.pendingContextSnapshot = null;

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

    this.abortController = new AbortController();
    let signalCleanup: (() => void) | undefined;
    let signal: AbortSignal;
    if (sendOptions?.signal) {
      const combined = this.combineSignals(sendOptions.signal, this.abortController.signal);
      signal = combined.signal;
      signalCleanup = combined.cleanup;
    } else {
      signal = this.abortController.signal;
    }

    const snapshot =
      pendingSnapshot ??
      createContextSnapshot(this.sessionId, nanoid(), this.defaultContext, sendOptions?.context);
    runtime.prepareTurn(snapshot);

    yield* this.streamExperimentalKernelTurn({
      runtime,
      message,
      streamOptions: options,
      sendOptions,
      snapshot,
      signal,
      signalCleanup,
      traceRecorder,
      finishTrace,
    });
  }

  private async *streamExperimentalKernelTurn(options: {
    runtime: SessionRuntime;
    message: UserMessageContent;
    streamOptions?: StreamOptions;
    sendOptions: SendOptions | null;
    snapshot: ContextSnapshot;
    traceRecorder?: TraceRecorder;
    finishTrace: (
      status: 'success' | 'error' | 'aborted',
      data?: Record<string, unknown>,
    ) => Promise<void>;
    signal: AbortSignal;
    signalCleanup?: () => void;
  }): AsyncGenerator<StreamMessage> {
    const startedAt = Date.now();
    let finalContent = '';
    let usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 0,
    };
    let errorMessage: string | undefined;
    let errorCode: string | undefined;
    let toolCallsCount = 0;

    options.runtime.getHookRuntime().setTraceCollector(options.traceRecorder);

    try {
      for await (const event of options.runtime.streamAgentKernelTurn({
        input: this.getTextContent(options.message),
        signal: options.signal,
        includeThinking: options.streamOptions?.includeThinking,
        maxSteps: options.sendOptions?.maxTurns ?? this.maxTurns,
        traceRecorder: options.traceRecorder,
        createExecutionContext: (_toolCall, signal) => ({
          sessionId: this.sessionId,
          contextSnapshot: options.snapshot,
          signal,
        }),
      })) {
        if (event.type === 'result' && event.subtype === 'success') {
          finalContent = event.content ?? '';
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'error') {
          errorMessage = event.message;
          errorCode = event.code;
        } else if (event.type === 'tool_use') {
          toolCallsCount += 1;
        }

        yield event;
      }

      await this.syncMessagesFromRuntime(options.runtime);

      if (errorMessage) {
        await options.finishTrace(
          errorCode === 'ABORTED' || options.signal.aborted ? 'aborted' : 'error',
          { error: errorMessage },
        );
        return;
      }

      const imageCount = this.getImageCount(options.message);
      await options.runtime.getHookRuntime().runTaskCompleted({
        taskId: this.sessionId,
        taskDescription: this.getTextContent(options.message),
        hasImages: imageCount > 0,
        imageCount,
        resultSummary: finalContent,
        success: true,
      });
      await options.finishTrace(options.signal.aborted ? 'aborted' : 'success', {
        content: finalContent,
        usage,
        turnsCount: 1,
        toolCallsCount,
        duration: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.finishTrace('error', { error: message });
      yield { type: 'error', message, sessionId: this.sessionId };
    } finally {
      options.runtime.getHookRuntime().setTraceCollector(undefined);
      options.signalCleanup?.();
      this.abortController = null;
    }
  }

  private async syncMessagesFromRuntime(runtime: SessionRuntime): Promise<void> {
    const contextManager = runtime.getAgentRuntimeDeps().contextManager;
    if (!contextManager) {
      throw new Error('Session context manager is not available');
    }
    const formatted = await contextManager.getFormattedContext();
    this._messages = formatted.context.layers.conversation.messages.map((message) => {
      const metadata = message.metadata;
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        ...(metadata ? { metadata } : {}),
        ...(typeof metadata?.reasoningContent === 'string'
          ? { reasoningContent: metadata.reasoningContent }
          : {}),
        ...(isSessionToolCallArray(metadata?.toolCalls)
          ? { tool_calls: metadata.toolCalls }
          : {}),
        ...(typeof metadata?.tool_call_id === 'string'
          ? { tool_call_id: metadata.tool_call_id }
          : {}),
        ...(typeof metadata?.name === 'string' ? { name: metadata.name } : {}),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanupHandle?.unregister();
    this.cleanupHandle = null;
    this.abort();
    this.agent = null;
    this.initialized = false;
    this.pendingMessage = null;
    this.pendingSendOptions = null;
    this.pendingContextSnapshot = null;
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      try {
        await runtime.getHookRuntime().runSessionEnd({ reason: 'other' });
      } finally {
        await runtime.close();
      }
    }
    this.logger.debug(`[Session] Closed session ${this.sessionId}`);
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
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
        provider: this.options.provider.type,
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
    if (this.closed) {
      throw new Error('Session is closed');
    }
    if (!this.initialized) {
      await this.initialize();
    }
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

  private combineSignals(
    signal1: AbortSignal,
    signal2: AbortSignal,
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();

    if (signal1.aborted || signal2.aborted) {
      controller.abort();
      return { signal: controller.signal, cleanup: () => {} };
    }

    const cleanup = () => {
      signal1.removeEventListener('abort', onAbort);
      signal2.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      controller.abort();
    };

    signal1.addEventListener('abort', onAbort);
    signal2.addEventListener('abort', onAbort);

    return { signal: controller.signal, cleanup };
  }

  private createTraceRecorder(message: UserMessageContent): TraceRecorder | undefined {
    const observability = this.options.observability;
    if (!observability?.enabled) {
      return undefined;
    }
    const recorder = new TraceRecorder(this.sessionId, observability, {
      model: this.options.model,
      provider: this.options.provider.type,
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
      ? await this.store.forkState(this.sessionId, {
          messageId: options?.messageId,
        })
      : this.createSnapshotFromMessages(options?.messageId);

    const forkedSession = new Session({
      ...this.options,
      defaultContext: this.defaultContext,
    });
    await forkedSession.initialize();
    forkedSession._messages = this.cloneSnapshotMessages(snapshot);

    this.logger.debug(
      `[Session] Forked session ${this.sessionId} -> ${forkedSession.sessionId} with ${forkedSession._messages.length} messages`,
    );

    return forkedSession;
  }

  private cloneSnapshotMessages(snapshot: SessionSnapshot | null): Message[] {
    if (!snapshot) {
      return [];
    }

    return snapshot.messages.map(cloneMessage);
  }

  private createSnapshotFromMessages(messageId?: string): SessionSnapshot {
    let messages = this._messages.map(cloneMessage);

    if (messageId) {
      const endIndex = messages.findIndex((message) => message.id === messageId);
      if (endIndex === -1) {
        throw new Error(`Message with ID "${messageId}" not found in session history`);
      }
      messages = messages.slice(0, endIndex + 1);
    }

    return {
      sessionId: this.sessionId,
      messages,
      messageIds: messages
        .map((message) => message.id)
        .filter((id): id is string => typeof id === 'string'),
      lastActivity: Date.now(),
    };
  }

  private getTextContent(message: UserMessageContent): string {
    if (typeof message === 'string') {
      return message;
    }

    return message
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
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
  const session = new Session(options);
  await session.initialize();
  return session;
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'resumeSession() requires session persistence. Remove persistSession: false or use createSession().',
    );
  }
  const { sessionId, ...sessionOptions } = options;
  const session = new Session(sessionOptions, sessionId, true);
  await session.initialize();
  await session.loadHistory();
  return session;
}

export interface ForkOptions extends ResumeOptions {
  messageId?: string;
}

export async function forkSession(options: ForkOptions): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'forkSession() requires session persistence. Remove persistSession: false and call session.fork() on a live session instead.',
    );
  }
  const { sessionId, messageId, ...sessionOptions } = options;

  const sourceSession = new Session(sessionOptions, sessionId, true);
  await sourceSession.initialize();
  await sourceSession.loadHistory();

  const forkedSession = await sourceSession.fork({ messageId });

  await sourceSession.close();

  return forkedSession;
}

export async function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = new Session(options);
  await session.initialize();

  const toolCalls: ToolCallRecord[] = [];
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

