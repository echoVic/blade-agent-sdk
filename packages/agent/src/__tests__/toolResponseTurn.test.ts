import { describe, expect, it } from 'vitest';
import {
  handleAgentLoopToolResponseWithEmissions,
  ToolKind,
  type AgentFunctionToolCall,
  type AgentToolResultContentInput,
} from '../loop/index.js';

async function collectGenerator<TEvent, TResult>(
  generator: AsyncGenerator<TEvent, TResult>,
): Promise<{ events: TEvent[]; result: TResult }> {
  const events: TEvent[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

const makeCall = (
  name: string,
  args: Record<string, unknown> = {},
): AgentFunctionToolCall => ({
  id: `${name}-call`,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const mockRegistry = {
  get(name: string): { kind?: string } | undefined {
    if (name === 'Read') {
      return { kind: 'readonly' };
    }
    return undefined;
  },
};

describe('agent loop tool response turn orchestration', () => {
  it('executes tools, handles results, emits the tool turn tail, and continues', async () => {
    const operations: unknown[] = [];
    const toolCall = makeCall('Read');
    const result: AgentToolResultContentInput = {
      success: true,
      llmContent: 'read complete',
    };

    const signal = new AbortController().signal;

    const handled = await collectGenerator(
      handleAgentLoopToolResponseWithEmissions({
        executionResults: undefined,
        response: {
          toolCalls: [toolCall],
        },
        executionPipeline: {
          getRegistry: () => mockRegistry,
        },
        turnStateProjection: {
          turnState: {
            maxContextTokens: 128000,
            executionContext: { cwd: '/tmp/project' },
            permissionMode: 'default' as const,
          },
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default' as const,
        },
        signal,
        loopClock: {
          startTime: 1_000,
          resultTiming: ({ turnsCount, toolCallsCount }) => {
            operations.push({ type: 'timing', turnsCount, toolCallsCount });
            return {
              turnsCount,
              toolCallsCount,
              startTime: 1_000,
              now: 1_040,
            };
          },
        },
        turnsCount: 2,
        maxTurns: 5,
        effectiveMaxTurns: 5,
        isYoloMode: false,
        toolResultTracker: {
          toolCallsCount: 0,
          recentToolResults: [] as readonly AgentToolResultContentInput[],
          record(recordedResult) {
            operations.push({ type: 'record', result: recordedResult });
          },
        },
        tokenUsageTracker: { totalTokens: 42 },
        turnCounter: {
          reset: () => {
            operations.push({ type: 'reset' });
          },
        },
        conversation: {
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
          getContextMessages: () => {
            operations.push({ type: 'get_context_messages' });
            return [];
          },
          replaceContent: (messages) => {
            operations.push({ type: 'replace_content', messages });
          },
        },
        hooks: {
          tool: {
            afterExec: async (payload) => {
              operations.push({ type: 'hook', payload });
            },
          },
        },
        epoch: { isValid: true },
        streamingExecutionResults: undefined,
        executeToolCalls: async (executeInput) => {
          operations.push({ type: 'execute', executeInput });
          return [{ toolCall, result, toolUseUuid: 'tool-use-1' }];
        },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'tool_start', toolCall, toolKind: ToolKind.ReadOnly },
      { type: 'tool_result', toolCall, result },
      { type: 'turn_end', turn: 2, hasToolCalls: true },
    ]);
    expect(handled.result).toEqual({ action: 'continue' });
    expect(operations).toEqual([
      { type: 'execute', executeInput: expect.any(Object) },
      { type: 'record', result },
      { type: 'timing', turnsCount: 2, toolCallsCount: 0 },
      {
        type: 'hook',
        payload: {
          toolCall,
          result,
          toolUseUuid: 'tool-use-1',
        },
      },
      {
        type: 'append',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'Read-call',
            name: 'Read',
            content: 'read complete',
          },
        ],
      },
    ]);
  });
});
