import type { HookRuntime } from '../../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { PermissionMode, type PermissionsConfig } from '../../types/common.js';
import {
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createPermissionHandlerFromCanUseTool,
  createRuleBasedPermissionHandler,
  type CanUseTool,
  type PermissionHandler,
  type PermissionHandlerRequest,
  type PermissionResult as CanUseToolResult,
  type PermissionUpdate,
} from '../../types/permissions.js';
import { getErrorMessage, getErrorName } from '../../utils/errorUtils.js';
import type { ToolCatalog } from '../catalog/ToolCatalog.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  ConfirmationDetails,
  ToolEffect,
  ToolResult,
} from '../types/index.js';
import {
  normalizePermissionEffects,
  normalizeToolEffects,
} from '../types/index.js';
import {
  isReadOnlyKind,
  resolveToolBehaviorSafely,
  ToolErrorType,
  ToolKind,
  type Tool,
  type ToolBehavior,
  type ToolInvocation,
  validationErrorToToolResult,
} from '../types/ToolTypes.js';
import { FileLockManager } from './FileLockManager.js';
import { ResultArtifactStore } from './ResultArtifactStore.js';
import { DenialTracker } from './DenialTracker.js';

function getString(params: Record<string, unknown>, key: string, defaultValue = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : defaultValue;
}

function buildPermissionSignature(
  toolName: string,
  params: Record<string, unknown>,
  tool?: Pick<Tool, 'preparePermissionMatcher'>,
): string {
  const signatureContent = tool?.preparePermissionMatcher?.(params)?.signatureContent;
  return signatureContent ? `${toolName}:${signatureContent}` : toolName;
}

interface PipelineExecutionState {
  toolName: string;
  tool: Tool;
  params: Record<string, unknown>;
  context: ExecutionContext;
  result?: ToolResult;
  invocation?: ToolInvocation<unknown>;
  resolvedBehavior?: ToolBehavior;
  permissionCheckResult?: { reason?: string };
  affectedPaths: string[];
  needsConfirmation: boolean;
  toolRequestedConfirmation: boolean;
  confirmationReason?: string;
  permissionSignature?: string;
  hookToolUseId?: string;
}

/**
 * 执行管道
 */
export class ExecutionPipeline {
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly maxConcurrency: number;
  private readonly toolTimeoutMs: number | undefined;
  private readonly sessionApprovals = new Set<string>();
  private readonly denialTracker = new DenialTracker();
  private readonly hookRuntime?: HookRuntime;
  private readonly logger: InternalLogger;
  private readonly permissionRuleHandler: PermissionHandler;
  private readonly pathSafetyHandler: PermissionHandler;
  private readonly permissionHandlers: PermissionHandler[];
  private readonly defaultPermissionMode: PermissionMode;
  private readonly toolCatalog?: ToolCatalog;
  private readonly resultArtifactStore = new ResultArtifactStore();

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  ) {
    this.maxHistorySize = config.maxHistorySize || 1000;
    this.maxConcurrency = config.maxConcurrency ?? 10;
    this.toolTimeoutMs = config.toolTimeoutMs;
    this.hookRuntime = config.hookRuntime;
    this.logger = (config.logger ?? NOOP_LOGGER).child(LogCategory.EXECUTION);
    this.toolCatalog = config.toolCatalog;

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

    const tool = this.registry.get(toolName);
    if (!tool) {
      const result = this.normalizeResultEffects(await this.applyPostExecutionHooks(
        toolName,
        nextParams,
        context,
        this.createExecutionFailureResult(`Tool "${toolName}" not found`),
        executionId,
      ));
      this.addToHistory({
        executionId,
        toolName,
        params: nextParams,
        result,
        startTime,
        endTime: Date.now(),
        context,
      });
      return result;
    }

    const state: PipelineExecutionState = {
      toolName,
      tool,
      params: nextParams,
      context: {
        ...context,
        sessionId: context.sessionId || executionId,
      },
      affectedPaths: [],
      needsConfirmation: false,
      toolRequestedConfirmation: false,
    };

    // 检查工具是否需要文件锁
    const resolvedBehavior = resolveToolBehaviorSafely(tool, nextParams);
    const filePath =
      typeof nextParams.file_path === 'string' && nextParams.file_path.trim() !== ''
        ? String(nextParams.file_path)
        : null;
    const lockMode =
      resolvedBehavior?.isReadOnly === true && resolvedBehavior.isConcurrencySafe
        ? 'read'
        : 'write';

    const runPipeline = (): Promise<ToolResult> => {
      if (filePath) {
        const lockManager = FileLockManager.getInstance(this.logger);
        return lockManager.acquireLock(filePath, lockMode, () =>
          this.executeWithPipeline(state, executionId, startTime)
        );
      }
      return this.executeWithPipeline(state, executionId, startTime);
    };

    const result = await this.withTimeout(toolName, runPipeline);
    return result;
  }

  /**
   * 通过管道执行工具（内部方法）
   */
  private async executeWithPipeline(
    state: PipelineExecutionState,
    executionId: string,
    startTime: number
  ): Promise<ToolResult> {
    try {
      await this.applyPreToolUseHooks(state, executionId);
      if (!state.result && state.context.signal?.aborted) {
        state.result = this.createAbortedResult('任务已被用户中止');
      }
      if (!state.result) {
        await this.prepareExecution(state);
      }
      if (!state.result) {
        await this.resolveConfirmation(state);
      }
      if (!state.result) {
        await this.executeInvocation(state);
      }

      let result = await this.normalizeExecutionResult(state);
      result = this.normalizeResultEffects(await this.applyPostExecutionHooks(
        state.toolName,
        state.params,
        state.context,
        result,
        executionId,
      ));
      const endTime = Date.now();

      // 记录执行历史
      this.addToHistory({
        executionId,
        toolName: state.toolName,
        params: state.params,
        result,
        startTime,
        endTime,
        context: state.context,
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
        errorResult = this.normalizeResultEffects(await this.applyPostExecutionHooks(
          state.toolName,
          state.params,
          state.context,
          errorResult,
          executionId,
          { isTimeout },
        ));
      } catch (hookError) {
        // Hook 执行失败不应阻止错误处理
        console.warn(
          '[ExecutionPipeline] PostToolUseFailure hook execution failed:',
          hookError
        );
      }

      this.addToHistory({
        executionId,
        toolName: state.toolName,
        params: state.params,
        result: errorResult,
        startTime,
        endTime,
        context: state.context,
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

      const validationError = await invocation.validate?.(state.context);
      if (validationError) {
        state.result = validationErrorToToolResult(validationError);
        return;
      }

      const toolPermissionResult = state.tool.checkPermissions
        ? await state.tool.checkPermissions(invocation.params, state.context)
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
        state.toolRequestedConfirmation = true;
        state.confirmationReason =
          toolPermissionResult.message || 'Tool-specific confirmation required';
      }

      // After optional rebuild, re-extract invocation (may have been reconstructed)
      const currentInvocation = state.invocation ?? invocation;
      state.permissionSignature = buildPermissionSignature(
        state.tool.name,
        toParamsRecord(currentInvocation.params, state.params),
        state.tool,
      );

      let checkResult = await this.permissionRuleHandler(
        this.buildPermissionRequest(state, state.affectedPaths),
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
            state.confirmationReason = combineConfirmationReasons(
              state.confirmationReason,
              checkResult.message || 'User confirmation required',
            );
          }
          break;
        case 'allow':
          break;
      }

      const pathSafetyResult = await this.pathSafetyHandler(
        this.buildPermissionRequest(state, state.affectedPaths),
      );
      await this.handlePermissionHandlerResult(pathSafetyResult, state);
      if (state.result) {
        return;
      }
    } catch (error) {
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
        const result = await permissionHandler(request);
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

  private async executeInvocation(state: PipelineExecutionState): Promise<void> {
    if (!state.invocation) {
      state.result = this.createAbortedResult(
        'Pre-execution stage failed; cannot run tool',
      );
      return;
    }

    try {
      state.result = await state.invocation.execute(
        state.context.signal ?? new AbortController().signal,
        state.context.onProgress,
        state.context,
      );
    } catch (error) {
      state.result = this.createAbortedResult(`Tool execution failed: ${getErrorMessage(error)}`);
    }
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
        toolUseId: state.hookToolUseId ?? `tool_use_${executionId}`,
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
        success: true,
        llmContent: message,
        displayContent: message,
      };
      return;
    }

    if (hookResult.needsConfirmation) {
      state.needsConfirmation = true;
      state.confirmationReason = combineConfirmationReasons(
        state.confirmationReason,
        hookResult.reason || 'Hook requires confirmation',
      );
    }
  }

  private async applyPostExecutionHooks(
    toolName: string,
    params: Record<string, unknown>,
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

    const toolUseId = `tool_use_${executionId}`;
    const hookResult = result.success
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
          state.confirmationReason = undefined;
        }
        if (!state.toolRequestedConfirmation && !state.confirmationReason) {
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
        state.confirmationReason = combineConfirmationReasons(
          state.confirmationReason,
          result.message || 'User confirmation required',
        );
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

    try {
      const description = state.invocation.getDescription();
      const confirmationTitle =
        description && description !== `执行工具: ${state.tool.name}`
          ? `权限确认: ${description}`
          : `权限确认: ${state.permissionSignature ?? state.tool.name}`;

      const confirmationDetails: ConfirmationDetails = {
        title: confirmationTitle,
        message: state.confirmationReason || '此操作需要用户确认',
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
        this.logger.info(`[ExecutionPipeline] Requesting confirmation for ${state.tool.name}`);
        const response = await confirmationHandler.requestConfirmation(confirmationDetails);
        this.logger.info(`[ExecutionPipeline] Confirmation response: approved=${response.approved}`);

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
      state.result = this.createAbortedResult(
        `User confirmation failed: ${getErrorMessage(error)}`,
      );
    }
  }

  private createHookFailureResult(message: string): ToolResult {
    return this.createExecutionFailureResult(message);
  }

  private createExecutionFailureResult(message: string): ToolResult {
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

  private createAbortedResult(
    reason?: string,
    options?: { shouldExitLoop?: boolean },
  ): ToolResult {
    return {
      success: false,
      llmContent: `Tool execution aborted: ${reason || 'Unknown reason'}`,
      displayContent: `执行已中止: ${reason || '未知原因'}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
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

    if (!result.llmContent) {
      result.llmContent = 'Execution completed';
    }

    if (!result.displayContent) {
      result.displayContent = result.success ? '执行成功' : '执行失败';
    }

    if (!result.metadata) {
      result.metadata = {};
    }

    const maxResultSizeChars =
      state.tool.maxResultSizeChars ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(maxResultSizeChars) && maxResultSizeChars >= 0) {
      const llmContentLength = typeof result.llmContent === 'string' ? result.llmContent.length : undefined;
      const displayContentLength = typeof result.displayContent === 'string' ? result.displayContent.length : undefined;
      const exceedsLimit =
        (llmContentLength !== undefined && llmContentLength > maxResultSizeChars)
        || (displayContentLength !== undefined && displayContentLength > maxResultSizeChars);

      if (exceedsLimit) {
        try {
          const artifact = await this.resultArtifactStore.persist({
            executionId: state.context.sessionId || state.toolName,
            sessionId: state.context.sessionId,
            toolName: state.toolName,
            context: state.context,
            llmContent: typeof result.llmContent === 'string' ? result.llmContent : undefined,
            displayContent: typeof result.displayContent === 'string' ? result.displayContent : undefined,
          });
          const summary = `[externalized result to ${artifact.path}]`;
          if (llmContentLength !== undefined) {
            result.llmContent = summary;
            result.metadata.llmContentOriginalLength = llmContentLength;
          }
          if (displayContentLength !== undefined) {
            result.displayContent = summary;
            result.metadata.displayContentOriginalLength = displayContentLength;
          }
          result.metadata.resultExternalized = true;
          result.metadata.resultArtifactPath = artifact.path;
          result.metadata.resultSizeLimit = maxResultSizeChars;
        } catch {
          const llmContent = this.truncateStringResult(result.llmContent, maxResultSizeChars);
          if (llmContent) {
            result.llmContent = llmContent.value;
            result.metadata.resultTruncated = true;
            result.metadata.resultSizeLimit = maxResultSizeChars;
            result.metadata.llmContentOriginalLength = llmContent.originalLength;
          }

          const displayContent = this.truncateStringResult(
            result.displayContent,
            maxResultSizeChars,
          );
          if (displayContent) {
            result.displayContent = displayContent.value;
            result.metadata.resultTruncated = true;
            result.metadata.resultSizeLimit = maxResultSizeChars;
            result.metadata.displayContentOriginalLength = displayContent.originalLength;
          }
        }
      } else {
        const llmContent = this.truncateStringResult(result.llmContent, maxResultSizeChars);
        if (llmContent) {
          result.llmContent = llmContent.value;
          result.metadata.resultTruncated = true;
          result.metadata.resultSizeLimit = maxResultSizeChars;
          result.metadata.llmContentOriginalLength = llmContent.originalLength;
        }

        const displayContent = this.truncateStringResult(
          result.displayContent,
          maxResultSizeChars,
        );
        if (displayContent) {
          result.displayContent = displayContent.value;
          result.metadata.resultTruncated = true;
          result.metadata.resultSizeLimit = maxResultSizeChars;
          result.metadata.displayContentOriginalLength = displayContent.originalLength;
        }
      }
    }

    result.metadata.executionId = state.context.sessionId;
    result.metadata.toolName = state.toolName;
    result.metadata.timestamp = Date.now();

    state.result = result;
    return result;
  }

  private normalizeResultEffects(result: ToolResult): ToolResult {
    result.effects = normalizeToolEffects(result);
    return result;
  }

  private generatePreviewForTool(
    toolName: string,
    params: Record<string, unknown>,
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
    params: Record<string, unknown>,
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
      const mode = this.canExecuteInParallel(request.toolName, request.params)
        ? 'parallel'
        : 'serial';
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

  private canExecuteInParallel(
    toolName: string,
    params: Record<string, unknown>,
  ): boolean {
    const tool = this.registry.get(toolName);
    const behavior = resolveToolBehaviorSafely(tool, params);
    return behavior?.isReadOnly === true && behavior.isConcurrencySafe;
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
  permissionConfig?: PermissionsConfig;
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;
  hookRuntime?: HookRuntime;
  logger?: InternalLogger;
  maxConcurrency?: number;
  /**
   * Per-tool execution timeout in milliseconds.
   * When a tool exceeds this limit it is aborted and returns a TIMEOUT error.
   * Defaults to no timeout (undefined).
   */
  toolTimeoutMs?: number;
  toolCatalog?: ToolCatalog;
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
  existingReason: string | undefined,
  nextReason: string,
): string {
  if (!existingReason) {
    return nextReason;
  }

  const reasons = new Set([existingReason, nextReason].filter(Boolean));
  return [...reasons].join('\n');
}

function toParamsRecord(
  params: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : fallback;
}
