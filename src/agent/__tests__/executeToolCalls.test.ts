import { describe, expect, it, vi } from 'vitest';
import type { AgentFunctionToolCall } from '@blade-ai/agent/loop';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import { SessionId } from '../../types/branded.js';
import type {
  RunToolCallInput,
  RunToolCallPort,
  ToolExecutionOutcome,
} from '../loop/adapterContracts.js';
import { createExecuteToolCalls } from '../loop/executeToolCalls.js';
import { createRootRunToolCall } from '../loop/rootAgentLoopAdapter.js';

function toolCall(id: string): AgentFunctionToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: `tool-${id}`,
      arguments: '{}',
    },
  };
}

function outcome(call: AgentFunctionToolCall): ToolExecutionOutcome {
  return {
    toolCall: call,
    result: {
      success: true,
      llmContent: call.id,
    },
    toolUseUuid: null,
  };
}

function pipeline(): ExecutionPipeline {
  const registry = { get: vi.fn() };
  return {
    execute: vi.fn(),
    getRegistry: vi.fn(() => registry),
  } as unknown as ExecutionPipeline;
}

describe('createExecuteToolCalls', () => {
  it('forwards the complete input after ordered ready hooks', async () => {
    const call = toolCall('one');
    const executionPipeline = pipeline();
    const executionContext = {
      sessionId: SessionId('session-one'),
      userId: 'user-one',
    };
    const logger = { error: vi.fn() } as unknown as InternalLogger;
    const signal = new AbortController().signal;
    const order: string[] = [];
    let received: RunToolCallInput | undefined;
    const runToolCall: RunToolCallPort = vi.fn(async (input) => {
      order.push('port');
      received = input;
      return outcome(input.toolCall);
    });
    const executeToolCalls = createExecuteToolCalls(runToolCall);

    const results = await executeToolCalls({
      plan: { mode: 'serial', calls: [call] },
      executionPipeline,
      executionContext,
      permissionMode: 'autoEdit',
      signal,
      logger,
      hooks: {
        onUpdate: async () => {
          order.push('update');
        },
        onToolReady: async () => {
          order.push('ready');
        },
      },
    });

    expect(order).toEqual(['update', 'ready', 'port']);
    expect(received).toMatchObject({
      toolCall: call,
      executionPipeline,
      executionContext,
      permissionMode: 'autoEdit',
      signal,
      logger,
    });
    expect(results).toEqual([outcome(call)]);
  });

  it.each(['onUpdate', 'onToolReady'] as const)(
    'does not invoke the port when %s rejects',
    async (hookName) => {
      const call = toolCall(hookName);
      const runToolCall = vi.fn(async (_input: RunToolCallInput) => outcome(call));
      const hooks = {
        onUpdate: vi.fn(),
        onToolReady: vi.fn(),
        [hookName]: vi.fn(async () => {
          throw new Error(`${hookName} failed`);
        }),
      };

      await expect(createExecuteToolCalls(runToolCall)({
        plan: { mode: 'serial', calls: [call] },
        executionPipeline: pipeline(),
        executionContext: {
          sessionId: SessionId(`session-${hookName}`),
          userId: 'user',
        },
        hooks,
      })).rejects.toThrow(`${hookName} failed`);

      expect(runToolCall).not.toHaveBeenCalled();
      if (hookName === 'onUpdate') {
        expect(hooks.onToolReady).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps concurrent session inputs isolated', async () => {
    const seen = new Map<string, string>();
    const runToolCall: RunToolCallPort = async (input) => {
      await Promise.resolve();
      seen.set(input.toolCall.id, input.executionContext.sessionId);
      return outcome(input.toolCall);
    };
    const executeToolCalls = createExecuteToolCalls(runToolCall);
    const first = toolCall('first');
    const second = toolCall('second');

    await Promise.all([
      executeToolCalls({
        plan: { mode: 'serial', calls: [first] },
        executionPipeline: pipeline(),
        executionContext: {
          sessionId: SessionId('session-first'),
          userId: 'user-first',
        },
      }),
      executeToolCalls({
        plan: { mode: 'serial', calls: [second] },
        executionPipeline: pipeline(),
        executionContext: {
          sessionId: SessionId('session-second'),
          userId: 'user-second',
        },
      }),
    ]);

    expect(Object.fromEntries(seen)).toEqual({
      first: 'session-first',
      second: 'session-second',
    });
  });
});

describe('createRootRunToolCall', () => {
  it('adapts the root pipeline and supplies a default logger', async () => {
    type PackageLocalRunToolCall = NonNullable<Parameters<typeof createRootRunToolCall>[0]>;
    let received: Parameters<PackageLocalRunToolCall>[0] | undefined;
    const packageLocalRunToolCall: PackageLocalRunToolCall = vi.fn(async (input) => {
      received = input;
      return outcome(input.toolCall);
    });
    const rootPipeline = pipeline();
    const call = toolCall('adapter');
    const runToolCall = createRootRunToolCall(packageLocalRunToolCall);

    await runToolCall({
      toolCall: call,
      executionPipeline: rootPipeline,
      executionContext: {
        sessionId: SessionId('session-adapter'),
        userId: 'user-adapter',
      },
    });

    expect(received?.executionPipeline).not.toBe(rootPipeline);
    expect(received?.executionPipeline.getRegistry()).toBe(rootPipeline.getRegistry());
    expect(received?.logger).toBeDefined();

    const dynamicSignal = new AbortController().signal;
    const result: ToolResult = { success: true, llmContent: 'ok' };
    vi.mocked(rootPipeline.execute).mockResolvedValue(result);
    await expect(received?.executionPipeline.execute('tool', {}, {
      sessionId: 'package-session',
      userId: 'package-user',
      signal: dynamicSignal,
    })).resolves.toBe(result);
    expect(rootPipeline.execute).toHaveBeenCalledWith(
      'tool',
      {},
      expect.objectContaining({
        sessionId: 'session-adapter',
        userId: 'user-adapter',
        signal: dynamicSignal,
      }),
    );
  });
});
