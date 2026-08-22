import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { Agent } from '../agent/Agent.js';
import type { ChatContext, LoopResult, UserMessageContent } from '../agent/types.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { type CleanupHandle, registerCleanup } from '../lifecycle/CleanupRegistry.js';
import { createRootLogger, type InternalLogger, LogCategory } from '../logging/Logger.js';
import { type AgentTrace, TraceRecorder } from '../observability/index.js';
import {
    type ContextSnapshot,
    createContextSnapshot,
    type RuntimeContext,
} from '../runtime/index.js';
import type { ContentPart, Message } from '../services/ChatServiceInterface.js';
import { cloneMessage } from '../services/messageUtils.js';
import {
    CommandId,
    InputId,
    RequestId,
    SessionId,
} from '../types/branded.js';
import {
    type BladeConfig,
    type JsonValue,
    type ModelConfig,
    PermissionMode,
    type ProviderType,
} from '../types/common.js';
import {
    ActiveRequestController,
    type RequestAbortReason,
} from './ActiveRequestController.js';
import { DurableSessionJournal } from './events/DurableSessionJournal.js';
import type {
    DurableSessionProjection,
    DurableSessionRecoveryPlan,
} from './events/DurableSessionProjector.js';
import {
    type DurableRequestFinish,
    durableRequestFinishFromLoopResult,
    DurableSessionRecoveryRequiredError,
    SessionDurableRecorder,
    SessionDurableRecorderError,
} from './events/SessionDurableRecorder.js';
import {
    DurableEventType,
    type DurableRequestInterruptReason,
} from './events/types.js';
import {
    SessionInputInbox,
} from './SessionInputInbox.js';
import { SessionRuntime } from './SessionRuntime.js';
import {
    JsonlSessionStore,
    NoopSessionStore,
    type SessionSnapshot,
    type SessionStore,
} from './SessionStore.js';
import type {
    ForkSessionOptions,
    InputSubmission,
    ISession,
    McpServerStatus,
    McpToolInfo,
    ModelInfo,
    PendingSessionInput,
    PromptResult,
    ProviderConfig,
    SendOptions,
    SessionOptions,
    StreamMessage,
    StreamOptions,
    TokenUsage,
    ToolCallRecord,
} from './types.js';
import { InputPriority } from './types.js';

export interface ResumeOptions extends SessionOptions {
  sessionId: SessionId;
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
    }
  | {
      phase: 'running';
      requestId: RequestId;
      controller: ActiveRequestController;
      durableRecorder: SessionDurableRecorder | null;
    }
  | {
      phase: 'stopping';
      requestId: RequestId;
      controller: ActiveRequestController;
      durableRecorder: SessionDurableRecorder | null;
    }
  | { phase: 'closed' };

class Session implements ISession {
  readonly sessionId: SessionId;
  private agent: Agent | null = null;
  private runtime: SessionRuntime | null = null;
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
  private cleanupHandle: CleanupHandle | null = null;
  private readonly traces: AgentTrace[] = [];
  private readonly inputInbox = new SessionInputInbox();
  private readonly inputMutex = new Mutex();
  private durableJournal: DurableSessionJournal | null = null;
  private durableClosePromise: Promise<void> | null = null;

  /**
   * 请求阶段状态机：
   * - idle: 无待处理请求
   * - pending: send() 已调用，等待 stream() 消费
   * - running: stream() 正在执行
   * - stopping: 已请求中止，等待 stream() 完成清理
   * - closed: 会话已关闭
   *
   * 防止在 streaming 期间再次调用 send() 产生并发 generator 竞态。
   */
  private executionState: SessionExecutionState = { phase: 'idle' };

  constructor(
    options: SessionOptions,
    sessionId?: SessionId,
    isResume = false,
    private readonly durableOrigin: {
      source: 'create' | 'resume' | 'fork';
      parentSessionId?: SessionId;
    } = { source: isResume ? 'resume' : 'create' },
  ) {
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
    return this.executionState.phase === 'closed';
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

  async initialize(): Promise<void> {
    if (this.executionState.phase === 'closed') {
      throw new Error('Session is closed');
    }
    if (this.initialized) return;

    await this.initializeDurableJournal();
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
      // 恢复待处理输入并调度下一个排队输入的过程会读写 executionState 与
      // inputInbox，与其他状态转换保持一致地在 inputMutex 内完成。
      await this.inputMutex.runExclusive(() => {
        const dropped = this.inputInbox.restore(
          (state?.pendingInputs ?? []).map((input) => ({
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

  async send(
    message: UserMessageContent,
    options?: SendOptions,
  ): Promise<InputSubmission> {
    await this.ensureInitialized();

    return this.inputMutex.runExclusive(async () => {
      if (this.executionState.phase === 'closed') {
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
        this.inputInbox.reserve(input);
        try {
          await durableRecorder?.recordAccepted(inputId, message);
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
          this.inputInbox.remove(inputId);
          throw error;
        }
        this.executionState = this.createPendingState(
          requestId,
          input,
          options,
          durableRecorder,
        );
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
      if (
        options?.expectedRequestId
        && options.expectedRequestId !== activeRequestId
      ) {
        throw new SessionInputError(
          'SESSION_REQUEST_MISMATCH',
          `Expected request "${options.expectedRequestId}" but "${activeRequestId}" is active`,
        );
      }
      let canSteerCurrentRequest =
        priority !== InputPriority.LATER
        && this.executionState.phase !== 'stopping'
        && (this.executionState.phase !== 'running'
          || !this.executionState.controller.isSealed);
      if (!canSteerCurrentRequest) {
        priority = InputPriority.LATER;
      }

      const input: PendingSessionInput = {
        inputId,
        content: message,
        priority,
        targetRequestId: canSteerCurrentRequest
          ? activeRequestId
          : undefined,
        acceptedAt: Date.now(),
      };
      this.inputInbox.reserve(input);
      try {
        await this.persistInput(input);
        const requestStillAcceptsSteering =
          (this.executionState.phase === 'pending'
            || this.executionState.phase === 'running')
          && this.executionState.requestId === activeRequestId
          && !activeController.isSealed;
        if (canSteerCurrentRequest && !requestStillAcceptsSteering) {
          canSteerCurrentRequest = false;
          priority = InputPriority.LATER;
          this.inputInbox.retargetLater(inputId);
        }
        this.inputInbox.markCommitted(inputId);
        if (
          canSteerCurrentRequest
          && priority === InputPriority.NOW
          && this.executionState.phase === 'running'
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
            priority: priority === InputPriority.NOW
              ? InputPriority.NOW
              : InputPriority.NEXT,
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
      if (
        (this.executionState.phase === 'running'
          || this.executionState.phase === 'stopping')
        && this.executionState.controller.isInitialInput(inputId)
      ) {
        return false;
      }
      const input = this.inputInbox.claimForCancellation(inputId);
      if (!input) {
        return false;
      }

      const pendingState =
        this.executionState.phase === 'pending'
        && this.executionState.input.inputId === inputId
          ? this.executionState
          : null;
      let durablyInterrupted = false;
      if (pendingState) {
        const durableRecorder = await this.ensureDurableRecorder(
          pendingState.requestId,
          pendingState.input,
          pendingState.durableRecorder,
        );
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
        await this.getRuntime().getContextManager().saveInputCancelled(
          this.sessionId,
          inputId,
          'cancelled_by_user',
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

  async *stream(options?: StreamOptions): AsyncGenerator<StreamMessage> {
    await this.ensureInitialized();
    const runtime = this.getRuntime();

    // 声明请求所有权必须原子：相位检查、pending→running 转换与初始输入移除
    // 需在 inputMutex 内一次完成，避免与 send()/cancelInput()/finishRequest()
    // 对 executionState 的并发读写交错。
    const claimed = await this.inputMutex.runExclusive(async () => {
      if (this.executionState.phase !== 'pending') {
        return null;
      }
      const {
        requestId,
        input,
        message: initialMessage,
        options: sendOptions,
        snapshot: pendingSnapshot,
        durableRecorder: pendingDurableRecorder,
      } = this.executionState;
      const requestController = this.executionState.controller;
      const durableRecorder = pendingDurableRecorder
        ?? (this.durableJournal
          ? new SessionDurableRecorder(this.durableJournal, requestId, this.options.model)
          : null);
      if (durableRecorder && !pendingDurableRecorder) {
        await durableRecorder.recordAccepted(
          input.inputId,
          input.content,
          input.priority === InputPriority.LATER ? 'later' : 'next',
        );
      }
      await durableRecorder?.recordStarted(
        input.inputId,
        input.priority === InputPriority.LATER ? 'later' : 'next',
      );
      this.executionState = {
        phase: 'running',
        requestId,
        controller: requestController,
        durableRecorder,
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
      };
    });

    if (!claimed) {
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
    } = claimed;

    let durableFinishAttempted = false;
    let durableFinishCommitted = !durableRecorder;
    const finishDurableRequest = async (finish: DurableRequestFinish): Promise<void> => {
      if (!durableRecorder || durableFinishAttempted) {
        return;
      }
      durableFinishAttempted = true;
      if (!await durableRecorder.finish(finish)) {
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

    runtime.getHookRuntime().setTraceCollector(traceRecorder);
    try {
      message = await runtime.getHookRuntime().applyUserPromptSubmit(message);
    } catch (error) {
      let terminalError = error;
      try {
        await finishDurableRequest({ status: 'failed', error });
      } catch (durableError) {
        terminalError = new AggregateError(
          [error, durableError],
          'Request setup and durable finalization both failed',
        );
      }
      const errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      await finishTrace('error', { error: errorMessage });
      runtime.getHookRuntime().setTraceCollector(undefined);
      // 初始输入已在进入 running 时移出收件箱；hook 失败时仍需与正常路径一样
      // 释放请求资源，否则会话会永久停留在 running 且外部 AbortSignal 监听器泄漏。
      requestController.dispose();
      await this.finishRequest(requestId);
      if (durableRecorder && !durableFinishCommitted) {
        throw terminalError;
      }
      yield { type: 'error', message: errorMessage, sessionId: this.sessionId };
      return;
    }

    const toolCalls: ToolCallRecord[] = [];
    let totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 0,
    };

    const signal = requestController.requestSignal;

    const snapshot =
      pendingSnapshot ??
      createContextSnapshot(this.sessionId, nanoid(), this.defaultContext, sendOptions?.context);
    runtime.prepareTurn(snapshot);

    const context: ChatContext = {
      messages: this._messages,
      userId: 'sdk-user',
      sessionId: this.sessionId,
      snapshot,
      signal,
      permissionMode: this.permissionMode,
      backgroundAgentManager: runtime.getBackgroundAgentManager(),
    };

    const stream = this.getAgent().streamChat(message, context, {
      maxTurns: sendOptions?.maxTurns ?? this.maxTurns,
      signal,
      inputApplication: {
        inputId: input.inputId,
        requestId,
      },
      runControl: requestController,
      toolExecutionLifecycle: durableRecorder ?? undefined,
    });
    let agentStreamCompleted = false;

    try {
      let loopResult: LoopResult | undefined;
      const turnSpans = new Map<number, string>();
      const toolSpans = new Map<string, string>();

      while (true) {
        const { value, done } = await stream.next();
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
              id: value.toolCall.id,
              name: value.toolCall.function.name,
              input,
              output: '',
              duration: 0,
            });
            toolSpans.set(
              value.toolCall.id,
              traceRecorder?.recordToolStart(
                value.toolCall.id,
                value.toolCall.function.name,
                input,
              ) ?? '',
            );
            yield {
              type: 'tool_use',
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              id: value.toolCall.id,
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
              value.toolCall.id,
              value.toolCall.function.name,
              value.result.model,
              value.result.status === 'error',
            );
            toolSpans.delete(value.toolCall.id);
            yield {
              type: 'tool_result',
              id: value.toolCall.id,
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
      await runtime.getHookRuntime().runTaskCompleted({
        taskId: this.sessionId,
        taskDescription: this.getTextContent(message),
        hasImages: imageCount > 0,
        imageCount,
        resultSummary: loopResult.finalMessage || '',
        success: loopResult.success,
      });
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
      let terminalError = error;
      if (!durableFinishAttempted) {
        try {
          await finishDurableRequest({ status: 'failed', error });
        } catch (durableError) {
          terminalError = new AggregateError(
            [error, durableError],
            'Request execution and durable finalization both failed',
          );
        }
      }
      const errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      await finishTrace('error', { error: errorMessage });
      if (durableRecorder && !durableFinishCommitted) {
        throw terminalError;
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
          if (!durableFinishAttempted) {
            await finishDurableRequest({
              status: 'interrupted',
              reason: 'user_abort',
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
      runtime.getHookRuntime().setTraceCollector(undefined);
      requestController.dispose();
      await this.finishRequest(requestId);
      if (this.executionState.phase === 'closed') {
        await this.closeDurableSession();
      }
      if (cleanupError) {
        await Promise.reject(cleanupError);
      }
    }
  }

  async close(): Promise<void> {
    await this.closeInternal(true);
  }

  async disposeAfterFork(): Promise<void> {
    await this.closeInternal(false);
  }

  private async closeInternal(recordDurableClose: boolean): Promise<void> {
    // 关闭时对 executionState 的读写走 inputMutex，避免与并发 send()/stream()
    // 交错（例如 send() 在 await 处让出后用 pending 覆盖 closed）。
    const alreadyClosed = await this.inputMutex.runExclusive(async () => {
      if (this.executionState.phase === 'closed') {
        return true;
      }
      if (this.executionState.phase === 'pending') {
        const { controller, input, requestId } = this.executionState;
        controller.abortRequest({ kind: 'session_close' });
        if (recordDurableClose) {
          const durableRecorder = await this.ensureDurableRecorder(
            requestId,
            input,
            this.executionState.durableRecorder,
          );
          this.executionState.durableRecorder = durableRecorder;
          await durableRecorder?.finish({
            status: 'interrupted',
            reason: 'session_close',
          });
        }
        controller.dispose();
        this.inputInbox.remove(input.inputId);
      } else if (
        this.executionState.phase === 'running'
        || this.executionState.phase === 'stopping'
      ) {
        this.executionState.controller.abortRequest({ kind: 'session_close' });
      }
      this.executionState = { phase: 'closed' };
      return false;
    });
    if (alreadyClosed) {
      if (recordDurableClose) {
        await this.closeDurableSession();
      }
      return;
    }
    this.cleanupHandle?.unregister();
    this.cleanupHandle = null;
    this.agent = null;
    this.initialized = false;
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      try {
        await runtime.getHookRuntime().runSessionEnd({ reason: 'other' });
      } finally {
        await runtime.close();
      }
    }
    if (recordDurableClose) {
      await this.closeDurableSession();
    }
    this.logger.debug(`[Session] Closed session ${this.sessionId}`);
  }

  async abort(): Promise<void> {
    if (this.executionState.phase === 'running') {
      const { requestId, controller, durableRecorder } = this.executionState;
      controller.abortRequest({ kind: 'user_abort' });
      this.executionState = {
        phase: 'stopping',
        requestId,
        controller,
        durableRecorder,
      };
    } else if (this.executionState.phase === 'pending') {
      const pendingState = this.executionState;
      pendingState.controller.abortRequest({ kind: 'user_abort' });
      await this.inputMutex.runExclusive(async () => {
        if (
          this.executionState.phase !== 'pending'
          || this.executionState.requestId !== pendingState.requestId
        ) {
          return;
        }
        const durableRecorder = await this.ensureDurableRecorder(
          pendingState.requestId,
          pendingState.input,
          pendingState.durableRecorder,
        );
        pendingState.durableRecorder = durableRecorder;
        await durableRecorder?.finish({
          status: 'interrupted',
          reason: 'user_abort',
        });
        const { controller, input } = pendingState;
        controller.dispose();
        this.inputInbox.remove(input.inputId);
        this.executionState = { phase: 'idle' };
        this.scheduleNextQueuedInput();
      });
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
    if (this.executionState.phase === 'closed') {
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

  private async initializeDurableJournal(): Promise<void> {
    if (this.durableJournal) {
      return;
    }
    const eventStore = this.options.durableEventStore;
    if (!eventStore) {
      return;
    }

    const journal = await DurableSessionJournal.open(eventStore, this.sessionId);
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
      throw new SessionDurableRecorderError(
        `Durable Session ${this.sessionId} already exists`,
      );
    }
    if (projection.status === 'closed') {
      throw new SessionDurableRecorderError(
        `Durable Session ${this.sessionId} is closed`,
      );
    }
    const recoveryPlan = journal.getRecoveryPlan();
    if (recoveryPlan.action !== 'none') {
      throw new DurableSessionRecoveryRequiredError(recoveryPlan);
    }
    this.durableJournal = journal;
  }

  private async ensureDurableRecorder(
    requestId: RequestId,
    input: PendingSessionInput,
    existing: SessionDurableRecorder | null,
  ): Promise<SessionDurableRecorder | null> {
    if (existing || !this.durableJournal) {
      return existing;
    }
    const recorder = new SessionDurableRecorder(
      this.durableJournal,
      requestId,
      this.options.model,
    );
    await recorder.recordAccepted(
      input.inputId,
      input.content,
      input.priority === InputPriority.LATER ? 'later' : 'next',
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
    const closePromise = journal.commit({
      commandId: CommandId(nanoid()),
      events: [
        {
          type: DurableEventType.SESSION_CLOSED,
          data: { reason: 'shutdown' },
        },
      ],
    }).then(() => undefined);
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
    return reason?.kind === 'session_close' ? 'session_close' : 'user_abort';
  }

  private async finishRequest(requestId: RequestId): Promise<void> {
    await this.inputMutex.runExclusive(() => {
      if (
        (this.executionState.phase !== 'running'
          && this.executionState.phase !== 'stopping')
        || this.executionState.requestId !== requestId
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
      snapshot: createContextSnapshot(
        this.sessionId,
        nanoid(),
        this.defaultContext,
        options?.context,
      ),
    };
  }

  private scheduleNextQueuedInput(): void {
    if (this.executionState.phase !== 'idle') {
      return;
    }
    if (
      this.durableJournal
      && this.durableJournal.getRecoveryPlan().action !== 'none'
    ) {
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
    await this.getRuntime().getContextManager().saveInputEnqueued(
      this.sessionId,
      {
        inputId: input.inputId,
        content: input.content as JsonValue,
        priority: input.priority,
        targetRequestId: input.targetRequestId,
        acceptedAt: input.acceptedAt,
      },
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

    const forkedSession = new Session(
      {
        ...this.options,
        defaultContext: this.defaultContext,
      },
      undefined,
      false,
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
