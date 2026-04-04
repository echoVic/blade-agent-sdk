import { EventEmitter } from 'node:events';
import { HookManager } from '../../hooks/HookManager.js';
import { HookStage } from '../../hooks/HookStage.js';
import { PostToolUseHookStage } from '../../hooks/PostToolUseHookStage.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { PermissionMode, type PermissionsConfig } from '../../types/common.js';
import type { CanUseTool } from '../../types/permissions.js';
import { getErrorMessage, getErrorName } from '../../utils/errorUtils.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolExecution as ToolExecutionImpl } from '../types/ExecutionTypes.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  PipelineStage,
  ToolResult,
} from '../types/index.js';
import { getEffectiveProjectDir } from '../types/index.js';
import { ToolErrorType } from '../types/ToolTypes.js';
import { FileLockManager } from './FileLockManager.js';
import {
  ConfirmationStage,
  DiscoveryStage,
  ExecutionStage,
  FormattingStage,
  PermissionStage,
} from './PipelineStages.js';
import { DenialTracker } from './DenialTracker.js';



/**
 * 7阶段执行管道
 * Discovery → Permission → Hook(Pre) → Confirmation → Execution → PostHook → Formatting
 */
export class ExecutionPipeline extends EventEmitter {
  private stages: PipelineStage[];
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly maxConcurrency: number;
  private readonly toolTimeoutMs: number | undefined;
  private readonly sessionApprovals = new Set<string>();
  private readonly denialTracker = new DenialTracker();
  private readonly hooks?: ExecutionPipelineHooks;
  private readonly logger: InternalLogger;

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  ) {
    super();

    this.maxHistorySize = config.maxHistorySize || 1000;
    this.maxConcurrency = config.maxConcurrency ?? 10;
    this.toolTimeoutMs = config.toolTimeoutMs;
    this.hooks = config.hooks;
    this.logger = (config.logger ?? NOOP_LOGGER).child(LogCategory.EXECUTION);

    const permissionConfig: PermissionsConfig = config.permissionConfig || {
      allow: [],
      ask: [],
      deny: [],
    };
    const permissionMode = config.permissionMode ?? PermissionMode.DEFAULT;

    const permissionStage = new PermissionStage(
      permissionConfig,
      this.sessionApprovals,
      permissionMode,
      this.logger,
    );

    this.stages = [
      new DiscoveryStage(this.registry),
      permissionStage,
      new HookStage(),
      new ConfirmationStage(
        this.sessionApprovals,
        permissionStage.getPermissionChecker(),
        config.canUseTool,
        this.logger,
        this.denialTracker,
      ),
      new ExecutionStage(),
      new PostToolUseHookStage(),
      new FormattingStage(),
    ];
  }

  /**
   * 执行工具
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const executionId = this.generateExecutionId();
    const nextParams = { ...params };

    if (this.hooks?.beforeExecute) {
      const hookResult = await this.hooks.beforeExecute({
        toolName,
        params: nextParams,
        context,
      });
      const earlyResult = this.applyBeforeHookResult(toolName, nextParams, hookResult);
      if (earlyResult) {
        return earlyResult;
      }
    }

    // 创建执行实例
    const execution = new ToolExecutionImpl(toolName, nextParams, {
      ...context,
      sessionId: context.sessionId || executionId,
    });

    this.emit('executionStarted', {
      executionId,
      toolName,
      params,
      context,
      timestamp: startTime,
    });

    // 检查工具是否需要文件锁
    const tool = this.registry.get(toolName);
    const needsFileLock = tool && !tool.isConcurrencySafe;
    const filePath =
      needsFileLock && params.file_path ? String(params.file_path) : null;

    const runPipeline = (): Promise<ToolResult> => {
      if (needsFileLock && filePath) {
        const lockManager = FileLockManager.getInstance(this.logger);
        return lockManager.acquireLock(filePath, () =>
          this.executeWithPipeline(execution, executionId, startTime)
        );
      }
      return this.executeWithPipeline(execution, executionId, startTime);
    };

    const result = await this.withTimeout(toolName, runPipeline);
    return this.applyAfterExecuteHooks(toolName, nextParams, context, result);
  }

  /**
   * 通过管道执行工具（内部方法）
   */
  private async executeWithPipeline(
    execution: ToolExecutionImpl,
    executionId: string,
    startTime: number
  ): Promise<ToolResult> {
    try {
      // 依次执行各个阶段
      // Plan 模式 只读工具通过权限阶段自动放行，非只读工具走权限确认流程
      for (const stage of this.stages) {
        // 检查取消信号
        if (execution.context.signal?.aborted) {
          execution.abort('任务已被用户中止');
          break;
        }

        this.emit('stageStarted', {
          executionId,
          stageName: stage.name,
          timestamp: Date.now(),
        });

        await stage.process(execution);

        this.emit('stageCompleted', {
          executionId,
          stageName: stage.name,
          timestamp: Date.now(),
        });

        // 检查是否应该中止
        if (execution.shouldAbort()) {
          break;
        }
      }

      const result = execution.getResult();
      const endTime = Date.now();

      // 记录执行历史
      this.addToHistory({
        executionId,
        toolName: execution.toolName,
        params: execution.params,
        result,
        startTime,
        endTime,
        context: execution.context,
      });

      this.emit('executionCompleted', {
        executionId,
        toolName: execution.toolName,
        result,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      return result;
    } catch (error) {
      const endTime = Date.now();
      const errorMsg = getErrorMessage(error);
      const isTimeout =
        errorMsg.includes('timeout') ||
        getErrorName(error) === 'TimeoutError';

      let errorResult: ToolResult = {
        success: false,
        llmContent: `Tool execution failed: ${errorMsg}`,
        displayContent: `错误: ${errorMsg}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: errorMsg,
        },
      };

      try {
        const projectDir = getEffectiveProjectDir(execution.context);
        if (!projectDir) {
          return errorResult;
        }

        const hookManager = HookManager.getInstance();
        const hookResult = await hookManager.executePostToolUseFailureHooks(
          execution.toolName,
          `tool_use_${executionId}`,
          execution.params,
          errorMsg,
          {
            projectDir,
            sessionId: execution.context.sessionId || 'unknown',
            permissionMode: execution.context.permissionMode ?? PermissionMode.DEFAULT,
            isInterrupt: false,
            isTimeout,
            abortSignal: execution.context.signal,
          }
        );

        // 如果 hook 返回 additionalContext，附加到错误信息
        if (hookResult.additionalContext) {
          errorResult = {
            ...errorResult,
            llmContent: `${errorResult.llmContent}\n\n${hookResult.additionalContext}`,
          };
        }

        // 如果有警告，记录日志
        if (hookResult.warning) {
          console.warn(
            `[ExecutionPipeline] PostToolUseFailure hook warning: ${hookResult.warning}`
          );
        }
      } catch (hookError) {
        // Hook 执行失败不应阻止错误处理
        console.warn(
          '[ExecutionPipeline] PostToolUseFailure hook execution failed:',
          hookError
        );
      }

      this.addToHistory({
        executionId,
        toolName: execution.toolName,
        params: execution.params,
        result: errorResult,
        startTime,
        endTime,
        context: execution.context,
      });

      this.emit('executionFailed', {
        executionId,
        toolName: execution.toolName,
        error,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      return errorResult;
    }
  }

  /**
   * 批量执行工具
   */
  async executeAll(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>
  ): Promise<ToolResult[]> {
    return this.executeTools(requests);
  }

  /**
   * 按工具并发安全策略执行工具
   */
  async executeTools(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>,
    maxConcurrency: number = this.maxConcurrency
  ): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(requests.length);
    const batches = this.partitionToolCalls(requests);

    for (const batch of batches) {
      if (batch.mode === 'parallel') {
        const batchResults = await this.executeWithConcurrency(
          batch.requests,
          maxConcurrency,
          async (request) => this.execute(request.toolName, request.params, request.context)
        );

        for (let i = 0; i < batch.requests.length; i++) {
          results[batch.requests[i].index] = batchResults[i];
        }
        continue;
      }

      for (const request of batch.requests) {
        results[request.index] = await this.execute(
          request.toolName,
          request.params,
          request.context
        );
      }
    }

    return results;
  }

  /**
   * 并行执行工具（带并发控制）
   */
  async executeParallel(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>,
    maxConcurrency: number = this.maxConcurrency
  ): Promise<ToolResult[]> {
    return this.executeTools(requests, maxConcurrency);
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
    this.emit('historyClear', { timestamp: Date.now() });
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
      if (entry.result.success) {
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
   * 添加自定义阶段
   */
  addStage(stage: PipelineStage, position = -1): void {
    if (position === -1) {
      // 插入到执行阶段之前
      const executionIndex = this.stages.findIndex((s) => s.name === 'execution');
      this.stages.splice(executionIndex, 0, stage);
    } else {
      this.stages.splice(position, 0, stage);
    }

    this.emit('stageAdded', {
      stageName: stage.name,
      position,
      timestamp: Date.now(),
    });
  }

  /**
   * 移除阶段
   */
  removeStage(stageName: string): boolean {
    const index = this.stages.findIndex((s) => s.name === stageName);
    if (index === -1) {
      return false;
    }

    this.stages.splice(index, 1);

    this.emit('stageRemoved', {
      stageName,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * 获取阶段列表
   */
  getStages(): PipelineStage[] {
    return [...this.stages];
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

  private applyBeforeHookResult(
    toolName: string,
    params: Record<string, unknown>,
    hookResult: ExecutionPipelineHookResult | undefined,
  ): ToolResult | null {
    if (!hookResult) {
      return null;
    }

    if (hookResult.modifiedInput) {
      Object.assign(params, hookResult.modifiedInput);
    }

    if (hookResult.action === 'abort') {
      return this.createHookFailureResult(
        hookResult.reason || `Tool "${toolName}" was aborted by hook`,
      );
    }

    if (hookResult.action === 'skip') {
      const message = hookResult.reason || `Tool "${toolName}" was skipped by hook`;
      return {
        success: true,
        llmContent: message,
        displayContent: message,
      };
    }

    return null;
  }

  private async applyAfterExecuteHooks(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (!this.hooks?.afterExecute) {
      return result;
    }

    const hookResult = await this.hooks.afterExecute({
      toolName,
      params,
      context,
      result,
    });

    if (!hookResult) {
      return result;
    }

    if (hookResult.action === 'abort') {
      return this.createHookFailureResult(
        hookResult.reason || `Tool "${toolName}" post-execution hook aborted`,
      );
    }

    if (hookResult.modifiedOutput === undefined) {
      return result;
    }

    const nextOutput = this.stringifyHookOutput(hookResult.modifiedOutput);
    return {
      ...result,
      llmContent: nextOutput,
      displayContent: nextOutput,
    };
  }

  private createHookFailureResult(message: string): ToolResult {
    return {
      success: false,
      llmContent: `Tool execution failed: ${message}`,
      displayContent: `错误: ${message}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message,
      },
    };
  }

  private stringifyHookOutput(output: unknown): string {
    if (typeof output === 'string') {
      return output;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private partitionToolCalls(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>
  ): PartitionedToolCallBatch[] {
    const batches: PartitionedToolCallBatch[] = [];
    let currentBatch: PartitionedToolCallBatch | null = null;

    for (const [index, request] of requests.entries()) {
      const mode = this.canExecuteInParallel(request.toolName) ? 'parallel' : 'serial';
      const indexedRequest: IndexedToolCallRequest = { ...request, index };

      if (!currentBatch || currentBatch.mode !== mode) {
        currentBatch = { mode, requests: [indexedRequest] };
        batches.push(currentBatch);
        continue;
      }

      currentBatch.requests.push(indexedRequest);
    }

    return batches;
  }

  private canExecuteInParallel(toolName: string): boolean {
    const tool = this.registry.get(toolName);
    return tool?.kind === 'readonly' && tool.isConcurrencySafe;
  }

  /**
   * Wraps a pipeline execution with an optional per-tool timeout.
   * When toolTimeoutMs is set and the tool exceeds it, the promise is rejected
   * with a TIMEOUT error result rather than throwing.
   */
  private async withTimeout(toolName: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!this.toolTimeoutMs) {
      return run();
    }
    const timeoutMs = this.toolTimeoutMs;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          llmContent: `Tool "${toolName}" timed out after ${timeoutMs}ms`,
          displayContent: `⏱ Tool "${toolName}" timed out after ${timeoutMs}ms`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Tool execution timeout after ${timeoutMs}ms`,
          },
        });
      }, timeoutMs);
      run().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private async executeWithConcurrency<TRequest, TResult>(    requests: TRequest[],
    maxConcurrency: number,
    executor: (request: TRequest) => Promise<TResult>,
  ): Promise<TResult[]> {
    if (requests.length === 0) {
      return [];
    }

    const results = new Array<TResult>(requests.length);
    const workerCount = Math.min(Math.max(maxConcurrency, 1), requests.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < requests.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await executor(requests[currentIndex]);
      }
    });

    await Promise.all(workers);
    return results;
  }
}

interface IndexedToolCallRequest {
  toolName: string;
  params: Record<string, unknown>;
  context: ExecutionContext;
  index: number;
}

interface PartitionedToolCallBatch {
  mode: 'parallel' | 'serial';
  requests: IndexedToolCallRequest[];
}

/**
 * 执行管道配置
 */
export interface ExecutionPipelineConfig {
  maxHistorySize?: number;
  enableMetrics?: boolean;
  customStages?: PipelineStage[];
  permissionConfig?: PermissionsConfig;
  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;
  hooks?: ExecutionPipelineHooks;
  logger?: InternalLogger;
  maxConcurrency?: number;
  /**
   * Per-tool execution timeout in milliseconds.
   * When a tool exceeds this limit it is aborted and returns a TIMEOUT error.
   * Defaults to no timeout (undefined).
   */
  toolTimeoutMs?: number;
}

export interface ExecutionPipelineHookContext {
  toolName: string;
  params: Record<string, unknown>;
  context: ExecutionContext;
}

export interface ExecutionPipelineAfterHookContext extends ExecutionPipelineHookContext {
  result: ToolResult;
}

export interface ExecutionPipelineHookResult {
  action?: 'continue' | 'skip' | 'abort';
  modifiedInput?: Record<string, unknown>;
  modifiedOutput?: unknown;
  reason?: string;
}

export interface ExecutionPipelineHooks {
  beforeExecute?: (
    context: ExecutionPipelineHookContext,
  ) => Promise<ExecutionPipelineHookResult | undefined>;
  afterExecute?: (
    context: ExecutionPipelineAfterHookContext,
  ) => Promise<ExecutionPipelineHookResult | undefined>;
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
