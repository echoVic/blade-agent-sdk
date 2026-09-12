import { ConfigError } from '../../errors/ConfigError.js';
import type { HookRuntime } from '../../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ToolMiddleware, ToolMiddlewareRequest } from '../../middleware/ToolMiddleware.js';
import { isExecutionLeaseFailure } from '../../session/events/DurableExecutionLeaseStore.js';
import { isSteeringInterruptSignal } from '../../types/abort.js';
import { PermissionMode } from '../../types/constants.js';
import { SessionId } from '../../types/identifiers.js';
import type { JsonObject } from '../../types/json.js';
import type { CanUseTool, PermissionHandler, PermissionsConfig } from '../../types/permissions.js';
import { getErrorMessage, getErrorName } from '../../utils/errorUtils.js';
import type { ToolCatalog } from '../catalog/ToolCatalog.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { ExecutionContext, ExecutionHistoryEntry } from '../types/execution.js';
import { resolveToolBehaviorSafely, ToolKind } from '../types/kind.js';
import { ToolErrorType, type ToolExecution, type ToolResult } from '../types/result.js';
import {
  type ConcurrencyLease,
  type ConcurrencyLimits,
  ConcurrencyScheduler,
} from './ConcurrencyScheduler.js';
import type { DenialTracker } from './DenialTracker.js';
import { ApprovalLedger } from './pipeline/ApprovalLedger.js';
import { InvocationBinder } from './pipeline/InvocationBinder.js';
import { MiddlewareBoundary } from './pipeline/MiddlewareBoundary.js';
import { PermissionDecisionApplier } from './pipeline/PermissionDecisionApplier.js';
import { PermissionRequestFactory } from './pipeline/PermissionRequestFactory.js';
import { ResultNormalizer } from './pipeline/ResultNormalizer.js';
import { createExecutionFailureResult, preserveTimeoutFailure } from './pipeline/results.js';
import { createSignalAbortResult } from './pipeline/signalAbort.js';
import type { PipelineExecutionState } from './pipeline/state.js';
import { AuthorizationStage } from './pipeline/stages/AuthorizationStage.js';
import { ConfirmationStage } from './pipeline/stages/ConfirmationStage.js';
import { FileLockStage } from './pipeline/stages/FileLockStage.js';
import { HookStage } from './pipeline/stages/HookStage.js';
import { InvocationStage } from './pipeline/stages/InvocationStage.js';
import { isTerminalCleanupFailure, TerminalCleanupGuard } from './pipeline/TerminalCleanupGuard.js';

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
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

export type { ConfirmationReasonEntry, ConfirmationReasonSource } from './pipeline/state.js';

/**
 * Executes tools through explicit, ordered stages.
 *
 * Order and ownership:
 * 1. middleware boundary — rewrites input, may short-circuit, cannot swap tool/context
 * 2. concurrency admission — queueing happens before any stage observes the call
 * 3. pre-tool hooks — abort/skip/confirm decisions
 * 4. cancellation gate — a signal that won the race ends the call here
 * 5. authorization — input validation, tool permissions, rules, path safety
 * 6. confirmation — configured permission handlers, then the user prompt
 * 7. file lock — readers/writers of the same target serialize here
 * 8. invocation — the tool runs under its deadline and owns its cleanup
 * 9. post-execution — result normalization, PostToolUse hooks, history
 *
 * Each stage lives in its own module and communicates only through
 * {@link PipelineExecutionState}; a stage that sets `state.result` ends the call.
 *
 * A failed execution-lease assertion or Hook process-containment cleanup permanently
 * quarantines this instance. Once quarantined, every later execution fails with the
 * original terminal error. The pipeline cannot be reset safely because ownership or
 * process containment is no longer provable; callers must stop using the owning Agent
 * or Session runtime and create a new one. Closing the quarantined runtime may report
 * the same terminal failure.
 */
export class ExecutionPipeline {
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly toolTimeoutMs: number;
  private readonly logger: InternalLogger;
  private readonly toolCatalog?: ToolCatalog;
  private readonly guard = new TerminalCleanupGuard();
  private readonly approvalLedger: ApprovalLedger;
  private readonly scheduler: ConcurrencyScheduler;
  private readonly middlewareBoundary: MiddlewareBoundary;
  private readonly hookStage: HookStage;
  private readonly authorizationStage: AuthorizationStage;
  private readonly confirmationStage: ConfirmationStage;
  private readonly fileLockStage: FileLockStage;
  private readonly invocationStage: InvocationStage;
  private readonly normalizer = new ResultNormalizer();

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {},
  ) {
    this.maxHistorySize = config.maxHistorySize || 1000;
    this.logger = (config.logger ?? NOOP_LOGGER).child(LogCategory.EXECUTION);
    this.toolCatalog = config.toolCatalog;
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
    const defaultPermissionMode = config.permissionMode ?? PermissionMode.DEFAULT;
    this.toolTimeoutMs = resolveToolTimeoutMs(config.toolTimeoutMs);

    const ledger = new ApprovalLedger(this.logger);
    this.approvalLedger = ledger;
    const binder = new InvocationBinder(this.guard);
    const requests = new PermissionRequestFactory(defaultPermissionMode, ledger);
    const decisions = new PermissionDecisionApplier(ledger, this.logger);

    this.middlewareBoundary = new MiddlewareBoundary(
      this.registry,
      [...(config.middleware ?? [])],
      this.logger,
    );
    this.hookStage = new HookStage(config.hookRuntime);
    this.authorizationStage = new AuthorizationStage(this.guard, binder, requests, decisions, ledger, {
      permissionConfig,
      defaultPermissionMode,
    });
    this.confirmationStage = new ConfirmationStage(
      this.guard,
      binder,
      requests,
      decisions,
      ledger,
      this.logger,
      {
        permissionMode: defaultPermissionMode,
        permissionHandler: config.permissionHandler,
        canUseTool: config.canUseTool,
      },
    );
    this.fileLockStage = new FileLockStage(this.logger, this.guard);
    this.invocationStage = new InvocationStage(this.toolTimeoutMs, this.guard);
  }

  getCatalog(): ToolCatalog | undefined {
    return this.toolCatalog;
  }

  hasPendingExecutionCleanup(): boolean {
    return this.guard.hasPendingExecutionCleanup();
  }

  hasPendingPermissionCleanup(): boolean {
    return this.guard.hasPendingPermissionCleanup();
  }

  getTerminalCleanupFailure(): unknown {
    return this.guard.getTerminalFailure();
  }

  /**
   * 执行工具
   */
  async *execute(toolName: string, params: JsonObject, context: ExecutionContext): ToolExecution {
    this.guard.throwIfFailed();
    if (this.guard.hasPendingCleanup()) {
      return this.guard.createPendingResult();
    }
    const startTime = Date.now();
    const executionId = this.generateExecutionId();
    const protectedContext = Object.freeze({
      ...context,
      sessionId: context.sessionId || SessionId(executionId),
    });

    let result: ToolResult | undefined;
    let effectiveRequest: ToolMiddlewareRequest | undefined;
    let completed = false;

    await protectedContext.assertExecutionLease?.();

    try {
      const outcome = yield* this.middlewareBoundary.run({
        toolName,
        params,
        context: protectedContext,
        executeCore: (request) => this.executeCore(request, executionId),
      });
      result = outcome.result;
      effectiveRequest = outcome.effectiveRequest;
      this.guard.throwIfFailed();
      await protectedContext.assertExecutionLease?.();
      completed = true;
      return result;
    } catch (error) {
      this.guard.remember(error);
      throw error;
    } finally {
      if (completed && result && effectiveRequest) {
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

  private async *executeCore(
    request: ToolMiddlewareRequest,
    executionId: string,
  ): ToolExecution {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return await this.hookStage.postExecutionFor(
        request.toolName,
        request.input,
        request.context,
        createExecutionFailureResult(`Tool "${request.toolName}" not found`),
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

    const resolvedBehavior = resolveToolBehaviorSafely(tool, request.input);
    const toolKind = resolvedBehavior?.kind ?? tool.kind ?? ToolKind.Execute;
    let concurrencyLease: ConcurrencyLease | undefined;

    try {
      concurrencyLease = await this.scheduler.acquire(toolKind, state.context.signal);
      this.guard.throwIfFailed();
      state.context.signal?.throwIfAborted();
      if (this.guard.hasPendingCleanup()) {
        return this.guard.createPendingResult();
      }
      await state.context.assertExecutionLease?.();
      this.guard.throwIfFailed();
      state.context.signal?.throwIfAborted();
      return yield* this.executeWithPipeline(state, executionId);
    } catch (error) {
      if (isTerminalCleanupFailure(error)) {
        throw error;
      }
      if (isExecutionLeaseFailure(state.context.signal?.reason)) {
        throw state.context.signal.reason;
      }
      if (state.context.signal?.aborted) {
        state.interrupted = isSteeringInterruptSignal(state.context.signal);
        return createSignalAbortResult(state.context.signal);
      }
      throw error;
    } finally {
      concurrencyLease?.release();
    }
  }

  /**
   * Ordered stage sequence for one tool call (steps 3-9 of the class contract).
   */
  private async *executeWithPipeline(
    state: PipelineExecutionState,
    executionId: string,
  ): ToolExecution {
    try {
      await this.hookStage.preToolUse(state, executionId);
      this.guard.throwIfFailed();

      if (!state.result && state.context.signal?.aborted) {
        state.interrupted = isSteeringInterruptSignal(state.context.signal);
        state.result = createSignalAbortResult(state.context.signal);
      }

      if (!state.result) {
        await this.authorizationStage.authorize(state);
        this.guard.throwIfFailed();
      }

      if (!state.result) {
        await this.confirmationStage.resolve(state);
        this.guard.throwIfFailed();
      }

      if (!state.result) {
        await this.fileLockStage.acquire(state);
      }

      if (!state.result) {
        yield* this.invocationStage.run(state);
      }

      await state.context.assertExecutionLease?.();

      const normalizedResult = await this.normalizer.normalize(state);
      const isTimeout =
        normalizedResult.status === 'error' &&
        normalizedResult.error.type === ToolErrorType.TIMEOUT_ERROR;
      let result: ToolResult;
      try {
        result = await this.hookStage.postExecution(state, executionId, normalizedResult, {
          isTimeout,
          isInterrupt: state.interrupted,
        });
      } catch (error) {
        if (isTerminalCleanupFailure(error)) {
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

      return preserveTimeoutFailure(
        this.logger,
        normalizedResult,
        result,
        `Post-execution hooks for ${state.toolName}`,
      );
    } catch (error) {
      if (isTerminalCleanupFailure(error)) {
        throw error;
      }
      const errorMsg = getErrorMessage(error);
      const isTimeout = errorMsg.includes('timeout') || getErrorName(error) === 'TimeoutError';
      const isInterrupt = state.interrupted || isSteeringInterruptSignal(state.context.signal);

      const originalErrorResult = createExecutionFailureResult(
        errorMsg,
        isTimeout
          ? ToolErrorType.TIMEOUT_ERROR
          : isInterrupt
            ? ToolErrorType.INTERRUPTED
            : ToolErrorType.EXECUTION_ERROR,
      );
      let errorResult: ToolResult = originalErrorResult;

      try {
        const hookResult = await this.hookStage.postExecution(
          state,
          executionId,
          errorResult,
          { isTimeout, isInterrupt },
        );
        errorResult = preserveTimeoutFailure(
          this.logger,
          originalErrorResult,
          hookResult,
          `Post-execution hooks for ${state.toolName}`,
        );
      } catch (hookError) {
        if (isTerminalCleanupFailure(hookError)) {
          throw hookError;
        }
        // Hook 执行失败不应阻止错误处理
        console.warn('[ExecutionPipeline] PostToolUseFailure hook execution failed:', hookError);
      }

      return errorResult;
    } finally {
      state.fileLease?.release();
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
    return this.approvalLedger.getDenialTracker();
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

    stats.averageDuration = stats.totalExecutions > 0 ? totalDuration / stats.totalExecutions : 0;

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
}

/**
 * 执行管道配置
 */
export interface ExecutionPipelineConfig {
  maxHistorySize?: number;
  enableMetrics?: boolean;
  permissionConfig?: PermissionsConfig;
  permissionMode?: PermissionMode;
  /**
   * Full permission callback. When provided, it takes precedence over the
   * legacy canUseTool callback.
   */
  permissionHandler?: PermissionHandler;
  /** Legacy permission callback, used only when permissionHandler is absent. */
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
