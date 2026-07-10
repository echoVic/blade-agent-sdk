import { describe, expect, it } from 'vitest';
import type {
  AgentFunctionToolCall,
  ToolExecutionPlan,
} from '../loop/planToolExecution.js';
import { executeToolExecutionPlan } from '../loop/executeToolExecutionPlan.js';

function makeCall(name: string): AgentFunctionToolCall {
  return {
    id: `${name}-call`,
    type: 'function',
    function: {
      name,
      arguments: '{}',
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getDeferred<T>(gates: Map<string, Deferred<T>>, id: string): Deferred<T> {
  const gate = gates.get(id);
  if (!gate) {
    throw new Error(`Missing deferred gate for ${id}`);
  }
  return gate;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('executeToolExecutionPlan', () => {
  it('executes serial calls in order without overlap', async () => {
    const calls = ['first', 'second', 'third'].map(makeCall);
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const results = await executeToolExecutionPlan({
      plan: { mode: 'serial', calls },
      execute: async (toolCall) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${toolCall.function.name}`);
        await tick();
        events.push(`end:${toolCall.function.name}`);
        active -= 1;
        return `result:${toolCall.function.name}`;
      },
    });

    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
    ]);
    expect(maxActive).toBe(1);
    expect(results).toEqual(['result:first', 'result:second', 'result:third']);
  });

  it('caps mixed groups at five while preserving group barriers and result order', async () => {
    const firstGroup = Array.from(
      { length: 7 },
      (_, index) => makeCall(`first-${index}`),
    );
    const secondGroup = Array.from(
      { length: 2 },
      (_, index) => makeCall(`second-${index}`),
    );
    const calls = [...firstGroup, ...secondGroup];
    const gates = new Map(
      calls.map((toolCall) => [
        toolCall.id,
        deferred<string>(),
      ]),
    );
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;

    const execution = executeToolExecutionPlan({
      plan: {
        mode: 'mixed',
        calls,
        groups: [firstGroup, secondGroup],
      },
      execute: async (toolCall) => {
        starts.push(toolCall.function.name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = await getDeferred(gates, toolCall.id).promise;
        active -= 1;
        return result;
      },
    });

    expect(starts).toEqual(firstGroup.slice(0, 5).map((call) => call.function.name));

    getDeferred(gates, firstGroup[4].id).resolve('result:first-4');
    await tick();
    expect(starts).toEqual(firstGroup.slice(0, 6).map((call) => call.function.name));

    getDeferred(gates, firstGroup[1].id).resolve('result:first-1');
    await tick();
    expect(starts).toEqual(firstGroup.map((call) => call.function.name));

    for (const index of [6, 5, 3, 2, 0]) {
      getDeferred(gates, firstGroup[index].id).resolve(`result:first-${index}`);
    }
    await tick();
    expect(starts).toEqual(calls.map((call) => call.function.name));

    getDeferred(gates, secondGroup[1].id).resolve('result:second-1');
    getDeferred(gates, secondGroup[0].id).resolve('result:second-0');

    await expect(execution).resolves.toEqual(
      calls.map((call) => `result:${call.function.name}`),
    );
    expect(maxActive).toBe(5);
  });

  it('treats mixed calls as one-call groups when groups are absent', async () => {
    const calls = ['first', 'second'].map(makeCall);
    const events: string[] = [];

    const results = await executeToolExecutionPlan({
      plan: { mode: 'mixed', calls },
      execute: async (toolCall) => {
        events.push(`start:${toolCall.function.name}`);
        await tick();
        events.push(`end:${toolCall.function.name}`);
        return `result:${toolCall.function.name}`;
      },
    });

    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
    expect(results).toEqual(['result:first', 'result:second']);
  });

  it('runs parallel calls with max concurrency five and stable result order', async () => {
    const calls = Array.from({ length: 7 }, (_, index) => makeCall(`call-${index}`));
    const gates = new Map(
      calls.map((toolCall) => [toolCall.id, deferred<string>()]),
    );
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;

    const execution = executeToolExecutionPlan({
      plan: { mode: 'parallel', calls },
      execute: async (toolCall) => {
        starts.push(toolCall.function.name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = await getDeferred(gates, toolCall.id).promise;
        active -= 1;
        return result;
      },
    });

    expect(starts).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4']);

    getDeferred(gates, calls[4].id).resolve('result:call-4');
    getDeferred(gates, calls[1].id).resolve('result:call-1');
    await tick();
    expect(starts).toEqual([
      'call-0',
      'call-1',
      'call-2',
      'call-3',
      'call-4',
      'call-5',
      'call-6',
    ]);

    for (const index of [6, 5, 3, 2, 0]) {
      getDeferred(gates, calls[index].id).resolve(`result:call-${index}`);
    }

    await expect(execution).resolves.toEqual(
      calls.map((toolCall) => `result:${toolCall.function.name}`),
    );
    expect(maxActive).toBe(5);
  });

  it('rejects parallel execution promptly while surviving workers continue', async () => {
    const calls = Array.from({ length: 6 }, (_, index) => makeCall(`call-${index}`));
    const gates = new Map(
      calls.map((toolCall) => [toolCall.id, deferred<string>()]),
    );
    const starts: string[] = [];
    const settled: string[] = [];
    const expectedError = new Error('parallel execution failed');

    const execution = executeToolExecutionPlan({
      plan: { mode: 'parallel', calls },
      execute: async (toolCall) => {
        starts.push(toolCall.function.name);
        try {
          return await getDeferred(gates, toolCall.id).promise;
        } finally {
          settled.push(toolCall.function.name);
        }
      },
    });

    expect(starts).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4']);

    const rejection = expect(execution).rejects.toBe(expectedError);
    getDeferred(gates, calls[0].id).reject(expectedError);
    await rejection;
    expect(starts).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4']);

    getDeferred(gates, calls[1].id).resolve('result:call-1');
    await tick();
    expect(starts).toEqual([
      'call-0',
      'call-1',
      'call-2',
      'call-3',
      'call-4',
      'call-5',
    ]);

    for (const index of [5, 4, 3, 2]) {
      getDeferred(gates, calls[index].id).resolve(`result:call-${index}`);
    }
    await tick();
    expect([...settled].sort()).toEqual(
      calls.map((toolCall) => toolCall.function.name).sort(),
    );
  });

  it.each<ToolExecutionPlan['mode']>(['serial', 'mixed', 'parallel'])(
    'returns an empty result for an empty %s plan',
    async (mode) => {
      const execute = () => Promise.resolve('unused');

      await expect(
        executeToolExecutionPlan({
          plan: { mode, calls: [] },
          execute,
        }),
      ).resolves.toEqual([]);
    },
  );
});
