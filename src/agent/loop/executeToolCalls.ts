import type { InternalLogger } from '../../logging/Logger.js';
import type { ModelToolCall } from '../../model/message.js';
import { isExecutionLeaseFailure } from '../../session/events/DurableExecutionLeaseStore.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { PermissionMode } from '../../types/constants.js';
import { AsyncChannel } from '../../utils/AsyncChannel.js';
import type { ToolExecutionPlan } from './planToolExecution.js';
import type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
  ToolExecutionUpdate,
} from './runToolCall.js';
import { runToolCall } from './runToolCall.js';

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
  steeringSignal?: AbortSignal;
  hooks?: ToolExecutionHooks;
}

export async function* streamToolCalls(
  input: ExecuteToolCallsInput,
): AsyncGenerator<ToolExecutionUpdate, ToolExecutionOutcome[]> {
  const queue = new AsyncChannel<ToolExecutionUpdate>(64);
  const closeController = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, closeController.signal])
    : closeController.signal;
  let outcomes: ToolExecutionOutcome[] | undefined;
  let failure: unknown;
  let completed = false;
  const execution = executeToolCalls({
    ...input,
    signal,
    hooks: {
      ...input.hooks,
      async onUpdate(update) {
        await input.hooks?.onUpdate?.(update);
        await queue.publish(update);
      },
    },
  })
    .then((results) => {
      outcomes = results;
    })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => queue.close());

  try {
    for await (const update of queue) yield update;
    await execution;
    completed = true;
    if (failure) throw failure;
    if (!outcomes) throw new Error('Tool execution completed without outcomes');
    return outcomes;
  } finally {
    if (!completed) {
      closeController.abort(new Error('Tool execution stream closed by consumer'));
      await execution;
    }
  }
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
      result.status === 'rejected' && isExecutionLeaseFailure(result.reason),
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
  toolCall: ModelToolCall,
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
