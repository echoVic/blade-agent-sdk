import type { HookRuntime } from '../../../../hooks/HookRuntime.js';
import { ToolUseId } from '../../../../types/identifiers.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ExecutionContext } from '../../../types/execution.js';
import type { ToolResult } from '../../../types/result.js';
import { createAbortedResult, createHookFailureResult } from '../results.js';
import { addConfirmationReason, type PipelineExecutionState } from '../state.js';

export interface PostExecutionHookOptions {
  isTimeout?: boolean;
  isInterrupt?: boolean;
}

/**
 * PreToolUse / PostToolUse / PostToolUseFailure hook boundary.
 *
 * Hooks may rewrite input, demand confirmation, skip a tool, or abort it, but
 * they never observe the pipeline's leases: the stage only returns decisions and
 * lets the orchestrator decide what a decision means for the remaining stages.
 */
export class HookStage {
  constructor(private readonly hookRuntime: HookRuntime | undefined) {}

  async preToolUse(state: PipelineExecutionState, executionId: string): Promise<void> {
    if (!this.hookRuntime) {
      return;
    }

    const hookResult = await this.hookRuntime.applyPreToolUse(state.toolName, state.params, {
      toolUseId: state.hookToolUseId ?? ToolUseId(`tool_use_${executionId}`),
      permissionMode: state.context.permissionMode,
      abortSignal: state.context.signal,
    });

    state.hookToolUseId = hookResult.toolUseId;
    state.params = {
      ...state.params,
      ...hookResult.updatedInput,
    };

    if (hookResult.action === 'abort') {
      state.result = createAbortedResult(
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

  async postExecution(
    state: PipelineExecutionState,
    executionId: string,
    result: ToolResult,
    options: PostExecutionHookOptions = {},
  ): Promise<ToolResult> {
    return await this.postExecutionFor(
      state.toolName,
      state.invocation?.params ?? state.params,
      state.context,
      result,
      executionId,
      options,
    );
  }

  /**
   * Post-execution boundary for calls without pipeline state, such as a tool
   * name that does not resolve to a registered tool.
   */
  async postExecutionFor(
    toolName: string,
    params: JsonObject,
    context: ExecutionContext,
    result: ToolResult,
    executionId: string,
    options: PostExecutionHookOptions = {},
  ): Promise<ToolResult> {
    if (!this.hookRuntime || context.signal?.aborted) {
      return result;
    }

    const toolUseId = ToolUseId(`tool_use_${executionId}`);
    const hookResult =
      result.status === 'success'
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
      return createHookFailureResult(
        hookResult.reason || `Tool "${toolName}" post-execution hook aborted`,
      );
    }

    return hookResult.result;
  }
}
