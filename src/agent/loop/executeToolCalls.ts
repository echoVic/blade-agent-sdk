import { isHookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import type { InternalLogger } from '../../logging/Logger.js';
import { isExecutionLeaseFailure } from '../../session/events/DurableExecutionLeaseStore.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { PermissionMode } from '../../types/common.js';
import type { ToolExecutionPlan } from './planToolExecution.js';
import type {
    ToolExecutionContext,
    ToolExecutionHooks,
    ToolExecutionOutcome,
} from './runToolCall.js';
import { runToolCall } from './runToolCall.js';
import type { FunctionToolCall } from './types.js';

export type {
    ToolExecutionContext,
    ToolExecutionHooks,
    ToolExecutionOutcome
} from './runToolCall.js';

interface ExecuteToolCallsInput {
  plan: ToolExecutionPlan;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  steeringSignal?: AbortSignal;
  hooks?: ToolExecutionHooks;
}

export async function executeToolCalls(
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome[]> {
  const { plan } = input;
  if (plan.mode === 'serial') {
    const results: ToolExecutionOutcome[] = [];
    for (const toolCall of plan.calls) {
      results.push(await executeToolCall(toolCall, input));
    }
    return results;
  }

  const settled = await Promise.allSettled(
    plan.calls.map((toolCall) => executeToolCall(toolCall, input)),
  );
  const criticalFailure = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected'
      && (
        isHookProcessContainmentError(result.reason)
        || isExecutionLeaseFailure(result.reason)
      ),
  );
  if (criticalFailure) {
    throw criticalFailure.reason;
  }
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }
  return settled.map((result) => {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    return result.value;
  });
}

async function executeToolCall(
  toolCall: FunctionToolCall,
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome> {
  return runToolCall({
    toolCall,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    logger: input.logger,
    permissionMode: input.permissionMode,
    signal: input.signal,
    steeringSignal: input.steeringSignal,
    hooks: input.hooks,
  });
}
