import type {
  AgentFunctionToolCall,
  ToolExecutionPlan,
} from './planToolExecution.js';

const MAX_CONCURRENT_TOOL_CALLS = 5;

export interface ExecuteToolExecutionPlanInput<TResult> {
  plan: ToolExecutionPlan;
  execute(toolCall: AgentFunctionToolCall): Promise<TResult>;
}

export async function executeToolExecutionPlan<TResult>(
  input: ExecuteToolExecutionPlanInput<TResult>,
): Promise<TResult[]> {
  const { execute, plan } = input;

  if (plan.mode === 'serial') {
    const results: TResult[] = [];
    for (const toolCall of plan.calls) {
      results.push(await execute(toolCall));
    }
    return results;
  }

  if (plan.mode === 'mixed') {
    const groups = plan.groups ?? plan.calls.map((toolCall) => [toolCall]);
    const results: TResult[] = [];

    for (const group of groups) {
      results.push(...await executeWithConcurrency(group, execute));
    }

    return results;
  }

  return executeWithConcurrency(plan.calls, execute);
}

async function executeWithConcurrency<TResult>(
  calls: AgentFunctionToolCall[],
  execute: (toolCall: AgentFunctionToolCall) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(calls.length);
  let nextIndex = 0;

  const workerCount = Math.min(MAX_CONCURRENT_TOOL_CALLS, calls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < calls.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await execute(calls[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}
