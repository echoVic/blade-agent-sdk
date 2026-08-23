import { ConfigError } from '../../errors/ConfigError.js';
import type { HookRuntime } from '../../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { composeMiddleware } from '../../middleware/composeMiddleware.js';
import type {
  ToolMiddleware,
  ToolMiddlewareRequest,
} from '../../middleware/ToolMiddleware.js';
import { isExecutionLeaseFailure } from '../../session/events/DurableExecutionLeaseStore.js';
import { isSteeringInterruptSignal } from '../../types/abort.js';
import {
  type PermissionRequestId,
  SessionId,
  ToolUseId,
} from '../../types/branded.js';
import { type JsonObject, PermissionMode, type PermissionsConfig } from '../../types/common.js';
import {
  type CanUseTool,
  type PermissionResult as CanUseToolResult,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createPermissionHandlerFromCanUseTool,
  createRuleBasedPermissionHandler,
  type PermissionHandler,
  type PermissionHandlerRequest,
  type PermissionUpdate,
} from '../../types/permissions.js';
import {
  awaitWithAbortSignal,
  getAbortSignalReason,
} from '../../utils/abortPromise.js';
import { getErrorMessage, getErrorName } from '../../utils/errorUtils.js';
import type { ToolCatalog } from '../catalog/ToolCatalog.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type {
  ConfirmationDetails,
  ExecutionContext,
  ExecutionHistoryEntry,
  ToolExecution,
  ToolResult,
  ToolYield,
} from '../types/index.js';
import { normalizePermissionEffects } from '../types/index.js';
import type { Tool, ToolInvocation } from '../types/ToolDefinition.js';
import {
  isReadOnlyKind,
  resolveToolBehaviorSafely,
  type ToolBehavior,
  ToolKind,
  ToolSideEffect,
} from '../types/ToolKind.js';
import {
  ToolErrorType,
  validationErrorToToolResult,
} from '../types/ToolResult.js';
import {
  type ConcurrencyLease,
  type ConcurrencyLimits,
  ConcurrencyScheduler,
} from './ConcurrencyScheduler.js';
import { DenialTracker } from './DenialTracker.js';
import { type FileLockLease, FileLockManager } from './FileLockManager.js';
import { ResultArtifactStore } from './ResultArtifactStore.js';

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
const MAX_TOOL_CLEANUP_WAIT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function resolveToolTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_DELAY_MS) {
    throw new ConfigError(
      `toolTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return resolved;
}

function getString(params: JsonObject, key: string, defaultValue = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : defaultValue;
}

function buildPermissionSignature(
  toolName: string,
  params: JsonObject,
  tool?: Pick<Tool, 'preparePermissionMatcher'>,
): string {
  const signatureContent = tool?.preparePermissionMatcher?.(params)?.signatureContent;
  return signatureContent ? `${toolName}:${signatureContent}` : toolName;
}

interface PipelineExecutionState {
  toolName: string;
  tool: Tool;
  params: JsonObject;
  context: ExecutionContext;
  result?: ToolResult;
  invocation?: ToolInvocation<JsonObject>;
  resolvedBehavior?: ToolBehavior;
  permissionCheckResult?: { reason?: string };
  affectedPaths: string[];
  needsConfirmation: boolean;
  confirmationReasons: ConfirmationReasonEntry[];
  permissionSignature?: string;
  hookToolUseId?: ToolUseId;
  interrupted: boolean;
}

class ToolCoreExecutionError extends Error {
  constructor(readonly cause: unknown) {
    super('Tool core execution failed', { cause });
    this.name = 'ToolCoreExecutionError';
  }
}

/**
 * Confirmation reason source.
 * Ranked for display: deny > tool > rule > path > handler.
 */
export type ConfirmationReasonSource = 'tool' | 'rule' | 'path' | 'handler' | 'hook';

export interface ConfirmationReasonEntry {
  source: ConfirmationReasonSource;
  message: string;
}

/**
 * 执行管道
 */
export class ExecutionPipeline {
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly toolTimeoutMs: number;
  private readonly sessionApprovals = new Set<string>();
  private readonly denialTracker = new DenialTracker();
  private readonly hookRuntime?: HookRuntime;
  private readonly logger: InternalLogger;
  private readonly permissionRuleHandler: PermissionHandler;
  private readonly pathSafetyHandler: PermissionHandler;
  private readonly permissionHandlers: PermissionHandler[];
  private readonly defaultPermissionMode: PermissionMode;
  private readonly toolCatalog?: ToolCatalog;
  private readonly middleware: readonly ToolMiddleware[];
  private readonly scheduler: ConcurrencyScheduler;
  private readonly resultArtifactStore = new ResultArtifactStore();
  private readonly pendingExecutionCleanups = new Set<Promise<void>>();
  private readonly activePermissionCallbacks = new Map<Promise<void>, AbortSignal>();

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  ) {
    this.maxHistorySize = config.maxHistorySize || 1000;
    this.toolTimeoutMs = resolveToolTimeoutMs(config.toolTimeoutMs);
    this.hookRuntime = config.hookRuntime;
    this.logger = (config.logger ?? NOOP_LOGGER).child(LogCategory.EXECUTION);
    this.toolCatalog = config.toolCatalog;
    this.middleware = [...(config.middleware ?? [])];
    this.scheduler =
      config.scheduler ??
      (config.concurrencyLimits
        ? new ConcurrencyScheduler(config.concurrencyLimits)
        : ConcurrencyScheduler.getInstance());

    const permissionConfig: PermissionsConfig = config.permissionConfig || {
      allow: [],
      ask: [],
      deny: [],
    };
    this.defaultPermissionMode = config.permissionMode ?? PermissionMode.DEFAULT;
    this.permissionRuleHandler = createRuleBasedPermissionHandler(permissionConfig);
    this.pathSafetyHandler = createPathSafetyPermissionHandler({
      explicitAllowRules: permissionConfig.allow,
    });
    this.permissionHandlers = [
      ...(config.permissionHandler
        ? [config.permissionHandler]
        : (config.canUseTool
          ? [createPermissionHandlerFromCanUseTool(config.canUseTool)]
          : [])),
      createModePermissionHandler(this.defaultPermissionMode),
    ];
  }

  getCatalog(): ToolCatalog | undefined {
    return this.toolCatalog;
  }

  hasPendingExecutionCleanup(): boolean {
    return this.pendingExecutionCleanups.size > 0;
  }

  hasPendingPermissionCleanup(): boolean {
    for (const signal of this.activePermissionCallbacks.values()) {
      if (signal.aborted) {
        return true;
      }
    }
    return false;
  }

  private hasPendingCleanup(): boolean {
    return this.hasPendingExecutionCleanup() || this.hasPendingPermissionCleanup();
  }

  /**
   * 执行工具
   */
  async *execute(
    toolName: string,
    params: JsonObject,
    context: ExecutionContext
  ): ToolExecution {
    if (this.hasPendingCleanup()) {
      return this.createPendingCleanupResult();
    }
    const startTime = Date.now();
    const executionId = this.generateExecutionId();
    const protectedContext = Object.freeze({
      ...context,
      sessionId: context.sessionId || SessionId(executionId),
    });
    const initialRequest: ToolMiddlewareRequest = {
      toolName,
      input: { ...params },
      context: protectedContext,
    };
    const initialBehavior = resolveToolBehaviorSafely(
      this.registry.get(toolName),
      initialRequest.input,
    );
    let effectiveRequest = initialRequest;
    let delegatedExecution: ToolExecution | undefined;
    let coreStarted = false;
    let coreCompleted = false;
    let coreResult: ToolResult | undefined;
    let coreFailure: ToolCoreExecutionError | undefined;
    let result: ToolResult | undefined;
    let completed = false;

    const captureRequest = (
      request: ToolMiddlewareRequest,
    ): ToolMiddlewareRequest => {
      if (request.toolName !== toolName) {
        throw new Error('Tool middleware cannot change the tool name');
      }
      if (request.context !== protectedContext) {
        throw new Error('Tool middleware cannot replace the execution context');
      }
      const effectiveBehavior = resolveToolBehaviorSafely(
        this.registry.get(toolName),
        request.input,
      );
      if (
        initialBehavior &&
        effectiveBehavior &&
        initialBehavior.interruptBehavior !== effectiveBehavior.interruptBehavior
      ) {
        throw new Error(
          'Tool middleware cannot change the tool interrupt behavior',
        );
      }
      effectiveRequest = Object.freeze({
        toolName: request.toolName,
        input: { ...request.input },
        context: request.context,
      });
      return effectiveRequest;
    };
    const guardedMiddleware = this.middleware.map<ToolMiddleware>(
      (middleware) => (request, next) => {
        const capturedRequest = captureRequest(request);
        return middleware(
          capturedRequest,
          (nextRequest = capturedRequest) => next(nextRequest),
        );
      },
    );
    const execute = composeMiddleware(
      guardedMiddleware,
      (request: ToolMiddlewareRequest): ToolExecution => {
        const coreRequest = captureRequest(request);
        delegatedExecution = this.executeCoreBoundary(
          coreRequest,
          executionId,
          () => {
            coreStarted = true;
          },
          (completedResult) => {
            coreCompleted = true;
            coreResult = completedResult;
          },
          (failure) => {
            coreFailure = failure;
          },
        );
        return delegatedExecution;
      },
    );

    await protectedContext.assertExecutionLease?.();

    try {
      if (protectedContext.signal?.aborted) {
        const isInterrupt = isSteeringInterruptSignal(protectedContext.signal);
        result = this.createAbortedResult(
          isInterrupt ? '工具执行被新的用户输入中断' : '任务已被用户中止',
          {
            errorType: isInterrupt
              ? ToolErrorType.INTERRUPTED
              : ToolErrorType.EXECUTION_ERROR,
          },
        );
      } else {
        try {
          result = yield* execute(initialRequest);
          if (coreFailure) {
            throw coreFailure;
          }
          if (coreStarted && !coreCompleted && delegatedExecution) {
            this.logger.warn(
              `Tool middleware returned before delegated ${toolName} execution completed; draining the core execution`,
            );
            result = yield* delegatedExecution;
          }
          if (
            coreResult?.status === 'error'
            && coreResult.error.type === ToolErrorType.TIMEOUT_ERROR
          ) {
            result = this.preserveTimeoutFailure(
              coreResult,
              result,
              `Tool middleware for ${toolName}`,
            );
          } else if (coreResult?.status === 'error' && result.status === 'success') {
            this.logger.warn(
              `Tool middleware attempted to replace failed ${toolName} core execution with success; preserving the core failure`,
            );
            result = coreResult;
          }
        } catch (error) {
          if (coreFailure) {
            throw coreFailure.cause;
          }
          if (error instanceof ToolCoreExecutionError) {
            throw error.cause;
          }
          if (isExecutionLeaseFailure(error)) {
            throw error;
          }
          if (isExecutionLeaseFailure(protectedContext.signal?.reason)) {
            throw protectedContext.signal.reason;
          }
          if (
            coreCompleted
            && coreResult?.status === 'error'
            && coreResult.error.type === ToolErrorType.TIMEOUT_ERROR
          ) {
            this.logger.warn(
              `Tool middleware failed after ${toolName} timed out; preserving the core timeout`,
            );
            result = coreResult;
          } else if (protectedContext.signal?.aborted) {
            const isInterrupt = isSteeringInterruptSignal(protectedContext.signal);
            result = this.createAbortedResult(
              isInterrupt ? '工具执行被新的用户输入中断' : '任务已被用户中止',
              {
                errorType: isInterrupt
                  ? ToolErrorType.INTERRUPTED
                  : ToolErrorType.EXECUTION_ERROR,
              },
            );
          } else {
            result = this.createExecutionFailureResult(
              `Tool middleware failed: ${getErrorMessage(error)}`,
            );
          }
        }
      }
      if (protectedContext.signal?.aborted) {
        if (coreCompleted && coreResult) {
          result = coreResult;
        } else {
          const isInterrupt = isSteeringInterruptSignal(protectedContext.signal);
          result = this.createAbortedResult(
            isInterrupt ? '工具执行被新的用户输入中断' : '任务已被用户中止',
            {
              errorType: isInterrupt
                ? ToolErrorType.INTERRUPTED
                : ToolErrorType.EXECUTION_ERROR,
            },
          );
        }
      }
      if (!coreStarted && result.status === 'success') {
        effectiveRequest = captureRequest(effectiveRequest);
        await this.recordMiddlewareShortCircuit(
          effectiveRequest,
        );
      }
      await protectedContext.assertExecutionLease?.();
      completed = true;
      return result;
    } finally {
      if (completed && result) {
        this.addToHistory({
          executionId,
          toolName,
          params: effectiveRequest.input,
          result,
          startTime,
          endTime: Date.now(),
          context: protectedContext,
        });
      }
    }
  }

  private async recordMiddlewareShortCircuit(
    request: ToolMiddlewareRequest,
  ): Promise<void> {
    const tool = this.registry.get(request.toolName);
    const sideEffect =
      resolveToolBehaviorSafely(tool, request.input)?.sideEffect ??
      tool?.sideEffect ??
      ToolSideEffect.NON_IDEMPOTENT;
    await request.context.assertExecutionLease?.();
    await request.context.toolInvocationLifecycle?.onExecutionStarted?.({
      input: structuredClone(request.input),
      sideEffect,
    });
  }

  private async *executeCoreBoundary(
    request: ToolMiddlewareRequest,
    executionId: string,
    onStart: () => void,
    onCompleted: (result: ToolResult) => void,
    onFailure: (failure: ToolCoreExecutionError) => void,
  ): ToolExecution {
    onStart();
    try {
      const result = yield* this.executeCore(request, executionId);
      onCompleted(result);
      return result;
    } catch (error) {
      const failure = new ToolCoreExecutionError(error);
      onFailure(failure);
      throw failure;
    }
  }

  private async *executeCore(
    request: ToolMiddlewareRequest,
    executionId: string,
  ): ToolExecution {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return await this.applyPostExecutionHooks(
        request.toolName,
        request.input,
        request.context,
        this.createExecutionFailureResult(`Tool "${request.toolName}" not found`),
        executionId,
      );
    }

    const state: PipelineExecutionState = {
      toolName: request.toolName,
      tool,
      params: request.input,
      context: request.context,
      affectedPaths: [],
      needsConfirmation: false,
      confirmationReasons: [],
      interrupted: false,
    };

    await state.context.assertExecutionLease?.();

    // 检查工具是否需要文件锁
    const resolvedBehavior = resolveToolBehaviorSafely(tool, request.input);
    const filePath =
      typeof request.input.file_path === 'string' && request.input.file_path.trim() !== ''
        ? String(request.input.file_path)
        : null;
    const lockMode =
      resolvedBehavior?.isReadOnly === true && resolvedBehavior.isConcurrencySafe
        ? 'read'
        : 'write';

    const toolKind = resolvedBehavior?.kind ?? tool.kind ?? ToolKind.Execute;
    let concurrencyLease: ConcurrencyLease | undefined;
    let fileLease: FileLockLease | undefined;

    try {
      concurrencyLease = await this.scheduler.acquire(
        toolKind,
        state.context.signal,
      );
      state.context.signal?.throwIfAborted();
      if (this.hasPendingCleanup()) {
        return this.createPendingCleanupResult();
      }
      fileLease = filePath
        ? await FileLockManager.getInstance(this.logger).acquire(
            filePath,
            lockMode,
            state.context.signal,
          )
        : undefined;
      state.context.signal?.throwIfAborted();
      if (this.hasPendingCleanup()) {
        return this.createPendingCleanupResult();
      }
      await state.context.assertExecutionLease?.();
      state.context.signal?.throwIfAborted();
      return yield* this.executeWithPipeline(state, executionId);
    } catch (error) {
      if (isExecutionLeaseFailure(error)) {
        throw error;
      }
      if (isExecutionLeaseFailure(state.context.signal?.reason)) {
        throw state.context.signal.reason;
      }
      if (state.context.signal?.aborted) {
        const isInterrupt = isSteeringInterruptSignal(state.context.signal);
        return this.createAbortedResult(
          isInterrupt ? '工具执行被新的用户输入中断' : '任务已被用户中止',
          {
            errorType: isInterrupt
              ? ToolErrorType.INTERRUPTED
              : ToolErrorType.EXECUTION_ERROR,
          },
        );
      }
      throw error;
    } finally {
      fileLease?.release();
      concurrencyLease?.release();
    }
  }

  /**
   * 通过管道执行工具（内部方法）
   */
  private async *executeWithPipeline(
    state: PipelineExecutionState,
    executionId: string,
  ): ToolExecution {
    try {
      await this.applyPreToolUseHooks(state, executionId);
      if (!state.result && state.context.signal?.aborted) {
        state.interrupted = isSteeringInterruptSignal(state.context.signal);
        state.result = this.createAbortedResult(
          state.interrupted ? '工具执行被新的用户输入中断' : '任务已被用户中止',
          {
            errorType: state.interrupted
              ? ToolErrorType.INTERRUPTED
              : ToolErrorType.EXECUTION_ERROR,
          },
        );
      }
      if (!state.result) {
        await this.prepareExecution(state);
      }
      if (!state.result) {
        await this.resolveConfirmation(state);
      }
      if (!state.result) {
        yield* this.executeInvocation(state);
      }
      await state.context.assertExecutionLease?.();

      const normalizedResult = await this.normalizeExecutionResult(state);
      const isTimeout =
        normalizedResult.status === 'error'
        && normalizedResult.error.type === ToolErrorType.TIMEOUT_ERROR;
      let result: ToolResult;
      try {
        result = await this.applyPostExecutionHooks(
          state.toolName,
          state.params,
          state.context,
          normalizedResult,
          executionId,
          { isTimeout, isInterrupt: state.interrupted },
        );
      } catch (error) {
        if (isExecutionLeaseFailure(error)) {
          throw error;
        }
        if (isTimeout) {
          this.logger.warn(
            `Post-execution hooks failed after ${state.toolName} timed out; preserving the timeout`,
          );
          return normalizedResult;
        }
        throw error;
      }

      return this.preserveTimeoutFailure(
        normalizedResult,
        result,
        `Post-execution hooks for ${state.toolName}`,
      );
    } catch (error) {
      if (isExecutionLeaseFailure(error)) {
        throw error;
      }
      const errorMsg = getErrorMessage(error);
      const isTimeout =
        errorMsg.includes('timeout') ||
        getErrorName(error) === 'TimeoutError';
      const isInterrupt =
        state.interrupted
        || isSteeringInterruptSignal(state.context.signal);

      const originalErrorResult: ToolResult = {
        status: 'error',
        model: `Tool execution failed: ${errorMsg}`,
        error: {
          type: isTimeout
            ? ToolErrorType.TIMEOUT_ERROR
            : isInterrupt
              ? ToolErrorType.INTERRUPTED
              : ToolErrorType.EXECUTION_ERROR,
          message: errorMsg,
        },
      };
      let errorResult: ToolResult = originalErrorResult;

      try {
        const hookResult = await this.applyPostExecutionHooks(
          state.toolName,
          state.params,
          state.context,
          errorResult,
          executionId,
          { isTimeout, isInterrupt },
        );
        errorResult = this.preserveTimeoutFailure(
          originalErrorResult,
          hookResult,
          `Post-execution hooks for ${state.toolName}`,
        );
      } catch (hookError) {
        if (isExecutionLeaseFailure(hookError)) {
          throw hookError;
        }
        // Hook 执行失败不应阻止错误处理
        console.warn(
          '[ExecutionPipeline] PostToolUseFailure hook execution failed:',
          hookError
        );
      }

      return errorResult;
    }
  }

  /**
   * 获取执行历史
   */
  getExecutionHistory(limit?: number): ExecutionHistoryEntry[] {
    const history = [...this.executionHistory];
    return limit ? history.slice(-limit) : history;
  }

  /** Get the denial tracker for this pipeline session. */
  getDenialTracker(): DenialTracker {
    return this.denialTracker;
  }

  /**
   * 清空执行历史
   */
  clearHistory(): void {
    this.executionHistory = [];
  }

  /**
   * 获取执行统计
   */
  getStats(): ExecutionStats {
    const stats: ExecutionStats = {
      totalExecutions: this.executionHistory.length,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageDuration: 0,
      toolUsage: new Map(),
      recentExecutions: this.executionHistory.slice(-10),
    };

    let totalDuration = 0;

    for (const entry of this.executionHistory) {
      if (entry.result.status === 'success') {
        stats.successfulExecutions++;
      } else {
        stats.failedExecutions++;
      }

      const duration = entry.endTime - entry.startTime;
      totalDuration += duration;

      // 统计工具使用情况
      const currentCount = stats.toolUsage.get(entry.toolName) || 0;
      stats.toolUsage.set(entry.toolName, currentCount + 1);
    }

    stats.averageDuration =
      stats.totalExecutions > 0 ? totalDuration / stats.totalExecutions : 0;

    return stats;
  }

  /**
   * 获取工具注册表（用于工具管理）
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * 生成执行ID
   */
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(entry: ExecutionHistoryEntry): void {
    this.executionHistory.push(entry);

    // 限制历史记录大小
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
    }
  }

  private async prepareExecution(state: PipelineExecutionState): Promise<void> {
    try {
      this.rebuildInvocationState(state);

      const invocation = state.invocation;
      if (!invocation) {
        throw new Error(`Failed to build invocation for tool: ${state.tool.name}`);
      }

      const validationError = invocation.validate
        ? await this.awaitPermissionCallback(
            () => invocation.validate?.(state.context),
            state.context.signal,
          )
        : undefined;
      if (validationError) {
        state.result = validationErrorToToolResult(validationError);
        return;
      }

      const toolPermissionResult = state.tool.checkPermissions
        ? await this.awaitPermissionCallback(
            () => state.tool.checkPermissions?.(invocation.params, state.context),
            state.context.signal,
          )
        : undefined;
      const toolPermissionUpdatedInput =
        toolPermissionResult?.behavior === 'allow'
          ? toolPermissionResult.updatedInput
          : undefined;

      if (toolPermissionUpdatedInput) {
        Object.assign(state.params, toolPermissionUpdatedInput);
        this.rebuildInvocationState(state);
      }

      if (toolPermissionResult?.behavior === 'deny') {
        state.result = this.createAbortedResult(toolPermissionResult.message, {
          shouldExitLoop: toolPermissionResult.interrupt,
        });
        return;
      }

      if (toolPermissionResult?.behavior === 'ask') {
        state.needsConfirmation = true;
        addConfirmationReason(state, 'tool', toolPermissionResult.message);
      }

      // After optional rebuild, re-extract invocation (may have been reconstructed)
      const currentInvocation = state.invocation ?? invocation;
      state.permissionSignature = buildPermissionSignature(
        state.tool.name,
        toParamsRecord(currentInvocation.params, state.params),
        state.tool,
      );

      let checkResult = await this.awaitPermissionCallback(
        () => this.permissionRuleHandler(
          this.buildPermissionRequest(state, state.affectedPaths),
        ),
        state.context.signal,
      );

      const hasRememberedApproval = Boolean(
        state.permissionSignature
        && this.sessionApprovals.has(state.permissionSignature),
      );

      if (hasRememberedApproval) {
        state.needsConfirmation = false;
        checkResult = {
          behavior: 'allow',
        };
      }

      state.permissionCheckResult = {
        reason: hasRememberedApproval
          ? 'User already allowed this operation in this session'
          : checkResult.behavior === 'allow'
            ? undefined
            : checkResult.message,
      };

      switch (checkResult.behavior) {
        case 'deny':
          state.result = this.createAbortedResult(
            checkResult.message || `Tool invocation "${state.tool.name}" was denied by permission rules`,
          );
          return;
        case 'ask':
          if (state.permissionSignature && this.sessionApprovals.has(state.permissionSignature)) {
            state.needsConfirmation = false;
          } else {
            state.needsConfirmation = true;
            addConfirmationReason(state, 'rule', checkResult.message);
          }
          break;
        case 'allow':
          break;
      }

      const pathSafetyResult = await this.awaitPermissionCallback(
        () => this.pathSafetyHandler(
          this.buildPermissionRequest(state, state.affectedPaths),
        ),
        state.context.signal,
      );
      await this.handlePermissionHandlerResult(pathSafetyResult, state);
      if (state.result) {
        return;
      }
    } catch (error) {
      if (state.context.signal?.aborted) {
        throw getAbortSignalReason(state.context.signal);
      }
      state.result = this.createAbortedResult(`Permission check failed: ${getErrorMessage(error)}`);
    }
  }

  private async resolveConfirmation(state: PipelineExecutionState): Promise<void> {
    if (!state.invocation) {
      state.result = this.createAbortedResult(
        'Pre-confirmation stage failed; cannot request user approval',
      );
      return;
    }

    const affectedPaths = state.invocation.getAffectedPaths() || [];

    if (this.permissionHandlers.length > 0) {
      for (const permissionHandler of this.permissionHandlers) {
        const request = this.buildPermissionRequest(state, affectedPaths);
        const result = await this.awaitPermissionCallback(
          () => permissionHandler(request),
          state.context.signal,
        );
        await this.handlePermissionHandlerResult(result, state, request);
        if (state.result) {
          return;
        }
      }
      if (!state.needsConfirmation) {
        return;
      }
    } else if (!state.needsConfirmation) {
      return;
    }

    await this.handleLegacyConfirmation(state, affectedPaths);
  }

  private async *executeInvocation(
    state: PipelineExecutionState,
  ): AsyncGenerator<ToolYield, void, void> {
    if (!state.invocation) {
      state.result = this.createAbortedResult(
        'Pre-execution stage failed; cannot run tool',
      );
      return;
    }
    if (this.hasPendingCleanup()) {
      state.result = this.createPendingCleanupResult();
      return;
    }

    await state.context.toolInvocationLifecycle?.onExecutionStarted?.({
      input: structuredClone(state.params),
      sideEffect: state.resolvedBehavior?.sideEffect ?? state.tool.sideEffect,
    });
    await state.context.assertExecutionLease?.();
    if (this.hasPendingCleanup()) {
      state.result = this.createPendingCleanupResult();
      return;
    }
    if (state.context.signal?.aborted) {
      state.result = this.createAbortedResult('Task was aborted before tool execution');
      return;
    }
    let completed = false;
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeoutError = this.createTimeoutError(state.toolName);
    const timeout = setTimeout(
      () => {
        timedOut = true;
        timeoutController.abort(timeoutError);
      },
      this.toolTimeoutMs,
    );
    const executionSignal = state.context.signal
      ? AbortSignal.any([state.context.signal, timeoutController.signal])
      : timeoutController.signal;
    const execution = state.invocation.execute(executionSignal, {
      ...state.context,
      signal: executionSignal,
    });

    try {
      while (true) {
        const step = await this.nextExecutionStep(execution, executionSignal);
        timeoutController.signal.throwIfAborted();
        if (step.done) {
          state.result = step.value;
          if (
            state.result.status === 'error'
            && isSteeringInterruptSignal(executionSignal)
          ) {
            state.interrupted = true;
            state.result = {
              ...state.result,
              error: {
                ...state.result.error,
                type: ToolErrorType.INTERRUPTED,
              },
            };
          }
          completed = true;
          return;
        }
        yield step.value;
      }
    } catch (error) {
      timedOut =
        timeoutController.signal.aborted
        || getErrorName(error) === 'TimeoutError';
      state.interrupted = !timedOut && isSteeringInterruptSignal(executionSignal);
      state.result = this.createExecutionFailureResult(
        timedOut
          ? `Tool execution timeout after ${this.toolTimeoutMs}ms`
          : getErrorMessage(error),
        timedOut
          ? ToolErrorType.TIMEOUT_ERROR
          : state.interrupted
            ? ToolErrorType.INTERRUPTED
            : ToolErrorType.EXECUTION_ERROR,
      );
    } finally {
      clearTimeout(timeout);
      if (!completed) {
        if (!executionSignal.aborted) {
          timeoutController.abort(new Error('Tool execution closed before completion'));
        }
        const closing = Promise.resolve(execution.return(undefined as never)).then(
          () => undefined,
          () => undefined,
        );
        this.trackPendingExecutionCleanup(closing);
        await this.waitForExecutionClose(closing);
      }
    }
  }

  private async nextExecutionStep(
    execution: ToolExecution,
    signal: AbortSignal,
  ): Promise<IteratorResult<ToolYield, ToolResult>> {
    if (signal.aborted) {
      throw signal.reason;
    }

    return new Promise<IteratorResult<ToolYield, ToolResult>>((resolve, reject) => {
      let settled = false;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (abortTimer !== undefined) {
          clearTimeout(abortTimer);
        }
        signal.removeEventListener('abort', onAbort);
      };
      const resolveOnce = (step: IteratorResult<ToolYield, ToolResult>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(step);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        // Preserve a terminal result produced in the same turn as cancellation.
        abortTimer = setTimeout(() => rejectOnce(signal.reason), 0);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      execution.next().then(
        resolveOnce,
        rejectOnce,
      );
    });
  }

  private async waitForExecutionClose(
    closing: PromiseLike<unknown>,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, MAX_TOOL_CLEANUP_WAIT_MS);
      closing.then(finish, finish);
    });
  }

  private trackPendingExecutionCleanup(closing: Promise<void>): void {
    this.pendingExecutionCleanups.add(closing);
    void closing.finally(() => {
      this.pendingExecutionCleanups.delete(closing);
    });
  }

  private async awaitPermissionCallback<T>(
    operation: () => T | PromiseLike<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return await operation();
    }

    signal.throwIfAborted();
    const callback = Promise.resolve().then(operation);
    const cleanup = callback.then(
      () => undefined,
      () => undefined,
    );
    this.activePermissionCallbacks.set(cleanup, signal);
    void cleanup.finally(() => {
      this.activePermissionCallbacks.delete(cleanup);
    });

    try {
      const result = await awaitWithAbortSignal(() => callback, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) {
        throw getAbortSignalReason(signal);
      }
      throw error;
    }
  }

  private createTimeoutError(toolName: string): Error {
    const error = new Error(`Tool "${toolName}" timed out after ${this.toolTimeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
  }

  private async applyPreToolUseHooks(
    state: PipelineExecutionState,
    executionId: string,
  ): Promise<void> {
    if (!this.hookRuntime) {
      return;
    }

    const hookResult = await this.hookRuntime.applyPreToolUse(
      state.toolName,
      state.params,
      {
        toolUseId: state.hookToolUseId ?? ToolUseId(`tool_use_${executionId}`),
        permissionMode: state.context.permissionMode,
        abortSignal: state.context.signal,
      },
    );

    state.hookToolUseId = hookResult.toolUseId;
    Object.assign(state.params, hookResult.updatedInput);

    if (hookResult.action === 'abort') {
      state.result = this.createAbortedResult(
        hookResult.reason || `Tool "${state.toolName}" was aborted by hook`,
      );
      return;
    }

    if (hookResult.action === 'skip') {
      const message = hookResult.reason || `Tool "${state.toolName}" was skipped by hook`;
      state.result = {
        status: 'success',
        model: message,
      };
      return;
    }

    if (hookResult.needsConfirmation) {
      state.needsConfirmation = true;
      addConfirmationReason(state, 'hook', hookResult.reason);
    }
  }

  private async applyPostExecutionHooks(
    toolName: string,
    params: JsonObject,
    context: ExecutionContext,
    result: ToolResult,
    executionId: string,
    options: {
      isTimeout?: boolean;
      isInterrupt?: boolean;
    } = {},
  ): Promise<ToolResult> {
    if (!this.hookRuntime) {
      return result;
    }

    const toolUseId = ToolUseId(`tool_use_${executionId}`);
    const hookResult = result.status === 'success'
      ? await this.hookRuntime.applyPostToolUse(toolName, params, result, {
          toolUseId,
          permissionMode: context.permissionMode,
          abortSignal: context.signal,
        })
      : await this.hookRuntime.applyPostToolUseFailure(toolName, params, result, {
          toolUseId,
          permissionMode: context.permissionMode,
          errorType: result.error?.type,
          isInterrupt: options.isInterrupt ?? false,
          isTimeout: options.isTimeout ?? false,
          abortSignal: context.signal,
        });

    if (hookResult.action === 'abort') {
      return this.createHookFailureResult(
        hookResult.reason || `Tool "${toolName}" post-execution hook aborted`,
      );
    }

    return hookResult.result;
  }

  private rebuildInvocationState(state: PipelineExecutionState): void {
    state.invocation = state.tool.build(state.params);
    state.resolvedBehavior = resolveToolBehaviorSafely(state.tool, state.invocation.params);
    state.affectedPaths = state.invocation.getAffectedPaths() || [];
    state.permissionSignature = buildPermissionSignature(
      state.tool.name,
      toParamsRecord(state.invocation.params, state.params),
      state.tool,
    );
  }

  private buildPermissionRequest(
    state: PipelineExecutionState,
    affectedPaths: string[],
  ): PermissionHandlerRequest {
    const resolvedBehavior = state.resolvedBehavior;
    const toolKind = resolvedBehavior?.kind ?? state.tool.kind ?? ToolKind.Execute;
    const invocationDescription = state.invocation?.getDescription();

    return {
      toolName: state.toolName,
      input: state.params,
      signal: state.context.signal || new AbortController().signal,
      permissionMode: state.context.permissionMode || this.defaultPermissionMode,
      sessionApproved: Boolean(
        state.permissionSignature
        && this.sessionApprovals.has(state.permissionSignature),
      ),
      affectedPaths,
      toolKind,
      toolMeta: {
        sideEffect: resolvedBehavior?.sideEffect ?? state.tool.sideEffect,
        isReadOnly: resolvedBehavior?.isReadOnly ?? isReadOnlyKind(toolKind),
        isConcurrencySafe: resolvedBehavior?.isConcurrencySafe ?? isReadOnlyKind(toolKind),
        isDestructive: resolvedBehavior?.isDestructive ?? false,
        signature: state.permissionSignature,
        description: invocationDescription,
      },
    };
  }

  private async handlePermissionHandlerResult(
    result: CanUseToolResult,
    state: PipelineExecutionState,
    request?: PermissionHandlerRequest,
  ): Promise<void> {
    switch (result.behavior) {
      case 'allow':
        if (result.updatedInput) {
          Object.assign(state.params, result.updatedInput);
          try {
            this.rebuildInvocationState(state);
          } catch (error) {
            state.result = this.createAbortedResult(
              `Permission handler updated parameters are invalid: ${getErrorMessage(error)}`,
            );
            return;
          }
          if (request) {
            request.input = state.params;
            request.toolMeta = {
              sideEffect: state.resolvedBehavior?.sideEffect ?? state.tool.sideEffect,
              isReadOnly:
                state.resolvedBehavior?.isReadOnly
                ?? isReadOnlyKind(state.resolvedBehavior?.kind ?? state.tool.kind),
              isConcurrencySafe: state.resolvedBehavior?.isConcurrencySafe
                ?? isReadOnlyKind(state.resolvedBehavior?.kind ?? state.tool.kind),
              isDestructive: state.resolvedBehavior?.isDestructive ?? false,
              signature: state.permissionSignature,
              description: state.invocation?.getDescription(),
            };
          }
        }
        for (const effect of normalizePermissionEffects(result)) {
          if (effect.type === 'permissionUpdates') {
            this.applyPermissionUpdates(effect.updates);
          }
        }
        if (state.permissionSignature && this.sessionApprovals.has(state.permissionSignature)) {
          state.needsConfirmation = false;
          state.confirmationReasons = [];
        }
        if (!hasToolRequestedConfirmation(state) && !getConfirmationReason(state)) {
          state.needsConfirmation = false;
        }
        this.logger.debug(`permissionHandler allowed: ${state.toolName}`);
        break;

      case 'deny':
        if (this.denialTracker && state.permissionSignature) {
          this.denialTracker.record(
            state.permissionSignature,
            state.toolName,
            result.message || 'Denied by permissionHandler',
          );
        }
        state.result = this.createAbortedResult(result.message, {
          shouldExitLoop: result.interrupt,
        });
        break;

      case 'ask':
        state.needsConfirmation = true;
        addConfirmationReason(state, 'handler', result.message);
        break;
    }
  }

  private applyPermissionUpdates(updates: PermissionUpdate[]): void {
    for (const update of updates) {
      switch (update.type) {
        case 'addRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            if (update.behavior === 'allow') {
              this.sessionApprovals.add(ruleStr);
            }
            this.logger.debug(`Permission rule added: ${ruleStr} -> ${update.behavior}`);
          }
          break;
        case 'removeRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            this.sessionApprovals.delete(ruleStr);
            this.logger.debug(`Permission rule removed: ${ruleStr}`);
          }
          break;
      }
    }
  }

  private async handleLegacyConfirmation(
    state: PipelineExecutionState,
    affectedPaths: string[],
  ): Promise<void> {
    if (!state.invocation) {
      state.result = this.createAbortedResult(
        'Pre-confirmation stage failed; cannot request user approval',
      );
      return;
    }

    let permissionRequestId: PermissionRequestId | undefined;
    let resolutionAttempted = false;
    try {
      const description = state.invocation.getDescription();
      const confirmationTitle =
        description && description !== `执行工具: ${state.tool.name}`
          ? `权限确认: ${description}`
          : `权限确认: ${state.permissionSignature ?? state.tool.name}`;

      const confirmationDetails: ConfirmationDetails = {
        title: confirmationTitle,
        message: getConfirmationReason(state) || '此操作需要用户确认',
        abortSignal: state.context.signal,
        kind: state.resolvedBehavior?.kind ?? state.tool.kind,
        details: this.generatePreviewForTool(state.tool.name, state.params),
        risks: this.extractRisksFromPermissionCheck(
          state.tool,
          state.params,
          state.permissionCheckResult,
        ),
        affectedFiles: affectedPaths,
      };

      this.logger.warn(`工具 "${state.tool.name}" 需要用户确认: ${confirmationDetails.title}`);

      const confirmationHandler = state.context.confirmationHandler;
      if (confirmationHandler) {
        permissionRequestId =
          await state.context.toolInvocationLifecycle?.onPermissionRequested?.(
            confirmationDetails,
            structuredClone(state.params),
          );
        this.logger.info(`[ExecutionPipeline] Requesting confirmation for ${state.tool.name}`);
        const response = await this.awaitPermissionCallback(
          () => confirmationHandler.requestConfirmation(confirmationDetails),
          state.context.signal,
        );
        this.logger.info(`[ExecutionPipeline] Confirmation response: approved=${response.approved}`);
        if (permissionRequestId) {
          resolutionAttempted = true;
          await state.context.toolInvocationLifecycle?.onPermissionResolved?.({
            permissionRequestId,
            decision: response.approved ? 'allow' : 'deny',
            ...(response.reason ? { message: response.reason } : {}),
          });
        }

        if (!response.approved) {
          const reason = response.reason || 'User rejected';
          if (this.denialTracker && state.permissionSignature) {
            this.denialTracker.record(
              state.permissionSignature,
              state.tool.name,
              reason,
            );
          }
          state.result = this.createAbortedResult(`User rejected execution: ${reason}`, {
            shouldExitLoop: true,
          });
          return;
        }

        if ((response.scope || 'once') === 'session' && state.permissionSignature) {
          this.sessionApprovals.add(state.permissionSignature);
        }
        state.needsConfirmation = false;
      } else {
        this.logger.warn('No ConfirmationHandler; auto-approving tool execution');
        state.needsConfirmation = false;
      }
    } catch (error) {
      let failure = error;
      if (permissionRequestId && !resolutionAttempted) {
        try {
          resolutionAttempted = true;
          await state.context.toolInvocationLifecycle?.onPermissionResolved?.({
            permissionRequestId,
            decision: 'cancel',
            message: getErrorMessage(error),
          });
        } catch (resolutionError) {
          failure = new AggregateError(
            [error, resolutionError],
            'Permission handling and durable resolution both failed',
          );
        }
      }
      if (state.context.signal?.aborted) {
        throw failure;
      }
      state.result = this.createAbortedResult(
        `User confirmation failed: ${getErrorMessage(failure)}`,
      );
    }
  }

  private createHookFailureResult(message: string): ToolResult {
    return this.createExecutionFailureResult(message);
  }

  private createExecutionFailureResult(
    message: string,
    type: ToolErrorType = ToolErrorType.EXECUTION_ERROR,
  ): ToolResult {
    return {
      status: 'error',
      model: `Tool execution failed: ${message}`,
      error: {
        type,
        message,
      },
    };
  }

  private createPendingCleanupResult(): ToolResult {
    const source = this.hasPendingPermissionCleanup()
      ? 'A permission callback'
      : 'A tool execution';
    return this.createExecutionFailureResult(
      `${source} is still cleaning up; refusing to start another tool`,
    );
  }

  private preserveTimeoutFailure(
    original: ToolResult,
    transformed: ToolResult,
    source: string,
  ): ToolResult {
    if (
      original.status !== 'error'
      || original.error.type !== ToolErrorType.TIMEOUT_ERROR
      || (
        transformed.status === 'error'
        && transformed.error.type === ToolErrorType.TIMEOUT_ERROR
      )
    ) {
      return transformed;
    }

    this.logger.warn(`${source} attempted to replace a tool timeout; preserving timeout semantics`);
    if (transformed.status === 'success') {
      return original;
    }
    return {
      ...transformed,
      error: {
        ...transformed.error,
        type: ToolErrorType.TIMEOUT_ERROR,
      },
    };
  }

  private createAbortedResult(
    reason?: string,
    options?: {
      shouldExitLoop?: boolean;
      errorType?: ToolErrorType;
    },
  ): ToolResult {
    return {
      status: 'error',
      model: `Tool execution aborted: ${reason || 'Unknown reason'}`,
      error: {
        type: options?.errorType ?? ToolErrorType.EXECUTION_ERROR,
        message: reason || 'Execution aborted',
      },
      metadata: options?.shouldExitLoop ? { shouldExitLoop: true } : undefined,
    };
  }

  private async normalizeExecutionResult(state: PipelineExecutionState): Promise<ToolResult> {
    const result = state.result;
    if (!result) {
      throw new Error('Tool execution result not set');
    }

    if (result.model === '' || result.model === null) {
      result.model = 'Execution completed';
    }

    if (!result.metadata) {
      result.metadata = {};
    }

    const maxResultSizeChars =
      state.tool.maxResultSizeChars ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(maxResultSizeChars) && maxResultSizeChars >= 0) {
      const modelContentLength = typeof result.model === 'string' ? result.model.length : undefined;
      const exceedsLimit =
        modelContentLength !== undefined && modelContentLength > maxResultSizeChars;

      if (exceedsLimit) {
        try {
          const artifact = await this.resultArtifactStore.persist({
            executionId: state.context.sessionId || state.toolName,
            sessionId: state.context.sessionId,
            toolName: state.toolName,
            context: state.context,
            modelContent: typeof result.model === 'string' ? result.model : undefined,
          });
          const summary = `[externalized result to ${artifact.path}]`;
          if (modelContentLength !== undefined) {
            result.model = summary;
            result.metadata.modelContentOriginalLength = modelContentLength;
          }
          result.metadata.resultExternalized = true;
          result.metadata.resultArtifactPath = artifact.path;
          result.metadata.resultSizeLimit = maxResultSizeChars;
        } catch {
          const modelContent = this.truncateStringResult(result.model, maxResultSizeChars);
          if (modelContent) {
            result.model = modelContent.value;
            result.metadata.resultTruncated = true;
            result.metadata.resultSizeLimit = maxResultSizeChars;
            result.metadata.modelContentOriginalLength = modelContent.originalLength;
          }
        }
      } else {
        const modelContent = this.truncateStringResult(result.model, maxResultSizeChars);
        if (modelContent) {
          result.model = modelContent.value;
          result.metadata.resultTruncated = true;
          result.metadata.resultSizeLimit = maxResultSizeChars;
          result.metadata.modelContentOriginalLength = modelContent.originalLength;
        }
      }
    }

    result.metadata.executionId = state.context.sessionId;
    result.metadata.toolName = state.toolName;
    result.metadata.timestamp = Date.now();

    state.result = result;
    return result;
  }

  private generatePreviewForTool(
    toolName: string,
    params: JsonObject,
  ): string | undefined {
    switch (toolName) {
      case 'Edit': {
        const oldString = getString(params, 'old_string');
        const newString = getString(params, 'new_string');
        if (!oldString && !newString) return undefined;

        const maxLines = 20;
        const truncate = (text: string): string => {
          const lines = text.split('\n');
          if (lines.length <= maxLines) return text;
          return `${lines.slice(0, maxLines).join('\n')}\n... (还有 ${lines.length - maxLines} 行)`;
        };

        return `**变更前:**\n\`\`\`\n${truncate(oldString || '(空)')}\n\`\`\`\n\n**变更后:**\n\`\`\`\n${truncate(newString || '(删除)')}\n\`\`\``;
      }
      case 'Write': {
        const content = getString(params, 'content');
        const encoding = getString(params, 'encoding', 'utf8');
        if (encoding !== 'utf8' || !content) {
          return `将写入 ${encoding === 'base64' ? 'Base64 编码' : encoding === 'binary' ? '二进制' : ''} 内容`;
        }

        const maxLines = 30;
        const lines = content.split('\n');
        if (lines.length <= maxLines) {
          return `**文件内容预览:**\n\`\`\`\n${content}\n\`\`\``;
        }

        const preview = lines.slice(0, maxLines).join('\n');
        return `**文件内容预览 (前 ${maxLines} 行):**\n\`\`\`\n${preview}\n\`\`\`\n\n... (还有 ${lines.length - maxLines} 行)`;
      }
      default:
        return undefined;
    }
  }

  private extractRisksFromPermissionCheck(
    tool: { name: string },
    params: JsonObject,
    permissionCheckResult?: { reason?: string },
  ): string[] {
    const risks: string[] = [];

    if (permissionCheckResult?.reason) {
      risks.push(permissionCheckResult.reason);
    }

    if (tool.name === 'Bash') {
      const command = getString(params, 'command');
      const mainCommand = command.trim().split(/\s+/)[0];

      if (['cat', 'head', 'tail'].includes(mainCommand)) {
        risks.push(`💡 建议使用 Read 工具代替 ${mainCommand} 命令`);
      } else if (['grep', 'rg'].includes(mainCommand)) {
        risks.push('💡 建议使用 Grep 工具代替 grep/rg 命令');
      } else if (mainCommand === 'find') {
        risks.push('💡 建议使用 Glob 工具代替 find 命令');
      } else if (['sed', 'awk'].includes(mainCommand)) {
        risks.push(`💡 建议使用 Edit 工具代替 ${mainCommand} 命令`);
      }

      if (command.includes('rm')) risks.push('⚠️ 此命令可能删除文件');
      if (command.includes('sudo')) risks.push('⚠️ 此命令需要管理员权限');
      if (command.includes('git push')) risks.push('⚠️ 此命令将推送代码到远程仓库');
    } else if (['Write', 'Edit'].includes(tool.name)) {
      risks.push('此操作将修改文件内容');
    } else if (tool.name === 'Delete') {
      risks.push('此操作将永久删除文件');
    }

    return risks;
  }

  private truncateStringResult(
    value: unknown,
    maxLength: number,
  ): { value: string; originalLength: number } | undefined {
    if (typeof value !== 'string' || value.length <= maxLength) {
      return undefined;
    }

    const removedChars = value.length - maxLength;
    const suffix = `\n\n...[truncated ${removedChars} chars]`;
    if (maxLength <= suffix.length) {
      return {
        value: value.slice(0, maxLength),
        originalLength: value.length,
      };
    }

    return {
      value: `${value.slice(0, maxLength - suffix.length)}${suffix}`,
      originalLength: value.length,
    };
  }

}

/**
 * 执行管道配置
 */
export interface ExecutionPipelineConfig {
  maxHistorySize?: number;
  enableMetrics?: boolean;
  permissionConfig?: PermissionsConfig;
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;
  hookRuntime?: HookRuntime;
  logger?: InternalLogger;
  /**
   * Per-tool execution timeout in milliseconds.
   * When a tool exceeds this limit it is aborted and returns a TIMEOUT error.
   * Defaults to 600000 (10 minutes).
   */
  toolTimeoutMs?: number;
  scheduler?: ConcurrencyScheduler;
  concurrencyLimits?: ConcurrencyLimits;
  toolCatalog?: ToolCatalog;
  middleware?: readonly ToolMiddleware[];
}

/**
 * 执行统计信息
 */
export interface ExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  toolUsage: Map<string, number>;
  recentExecutions: ExecutionHistoryEntry[];
}

function combineConfirmationReasons(
  entries: ConfirmationReasonEntry[],
): string | undefined {
  if (entries.length === 0) return undefined;
  const rank: Record<ConfirmationReasonSource, number> = {
    tool: 0,
    rule: 1,
    path: 2,
    hook: 3,
    handler: 4,
  };
  const seen = new Set<string>();
  const sorted = [...entries]
    .sort((a, b) => rank[a.source] - rank[b.source])
    .filter((entry) => {
      const key = `${entry.source}::${entry.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(entry.message);
    });
  return sorted.map((entry) => entry.message).join('\n') || undefined;
}

function addConfirmationReason(
  state: PipelineExecutionState,
  source: ConfirmationReasonSource,
  message: string | undefined,
): void {
  const msg = message || defaultReasonMessage(source);
  state.confirmationReasons.push({ source, message: msg });
}

/** Tool itself requested confirmation (vs. rule/path/hook/handler). */
function hasToolRequestedConfirmation(state: PipelineExecutionState): boolean {
  return state.confirmationReasons.some((r) => r.source === 'tool');
}

/** Combined, de-duplicated confirmation message derived from all reasons. */
function getConfirmationReason(state: PipelineExecutionState): string | undefined {
  return combineConfirmationReasons(state.confirmationReasons);
}

function defaultReasonMessage(source: ConfirmationReasonSource): string {
  switch (source) {
    case 'tool': return 'Tool-specific confirmation required';
    case 'rule': return 'User confirmation required';
    case 'path': return 'Path safety confirmation required';
    case 'hook': return 'Hook requires confirmation';
    case 'handler': return 'User confirmation required';
  }
}

function toParamsRecord(
  params: unknown,
  fallback: JsonObject,
): JsonObject {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as JsonObject
    : fallback;
}
