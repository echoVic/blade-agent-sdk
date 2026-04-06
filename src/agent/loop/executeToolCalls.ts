import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { PermissionMode } from '../../types/common.js';
import type { ToolExecutionPlan } from './planToolExecution.js';
import type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
} from './runToolCall.js';
import { emitToolExecutionUpdate, runToolCall } from './runToolCall.js';
import type { FunctionToolCall } from './types.js';

export type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
} from './runToolCall.js';

interface ExecuteToolCallsInput {
  plan: ToolExecutionPlan;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
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

  if (plan.mode === 'mixed') {
    const groups = plan.groups ?? plan.calls.map((toolCall) => [toolCall]);
    const results: ToolExecutionOutcome[] = [];

    for (const group of groups) {
      const groupResults = await executeWithConcurrency(
        group,
        5,
        (toolCall) => executeToolCall(toolCall, input),
      );
      results.push(...groupResults);
    }

    return results;
  }

  return executeWithConcurrency(
    plan.calls,
    5,
    (toolCall) => executeToolCall(toolCall, input),
  );
}

async function executeToolCall(
  toolCall: FunctionToolCall,
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome> {
  await emitToolExecutionUpdate(input.hooks, {
    type: 'tool_ready',
    toolCall,
  });
  return runToolCall({
    toolCall,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    logger: input.logger,
    permissionMode: input.permissionMode,
    signal: input.signal,
    hooks: input.hooks,
  });
}

async function executeWithConcurrency(
  calls: FunctionToolCall[],
  maxConcurrency: number,
  executor: (toolCall: FunctionToolCall) => Promise<ToolExecutionOutcome>,
): Promise<ToolExecutionOutcome[]> {
  const results = new Array<ToolExecutionOutcome>(calls.length);
  let nextIndex = 0;

  const workerCount = Math.min(maxConcurrency, calls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < calls.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await executor(calls[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}
