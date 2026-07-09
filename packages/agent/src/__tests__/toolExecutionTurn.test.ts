import { describe, expect, it } from 'vitest';
import {
  handleAgentLoopToolExecutionResultsWithEmissions,
  ToolKind,
  type AgentFunctionToolCall,
  type AgentToolResultContentInput,
} from '../loop/index.js';

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

describe('agent loop tool execution/result orchestration', () => {
  it('executes non-streaming tools through an injected executor before handling results', async () => {
    const operations: unknown[] = [];
    const toolCall = makeCall('Read');
    const result: AgentToolResultContentInput = {
      success: true,
      llmContent: 'read complete',
    };

    const generator = handleAgentLoopToolExecutionResultsWithEmissions({
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
      signal: undefined,
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => {
          operations.push({ type: 'timing', turnsCount, toolCallsCount });
          return {
            turnsCount,
            toolCallsCount,
            startTime: 1000,
            now: 1040,
          };
        },
      },
      turnsCount: 5,
      toolResultTracker: {
        toolCallsCount: 0,
        recentToolResults: [] as readonly AgentToolResultContentInput[],
        record(recordedResult) {
          operations.push({ type: 'record', result: recordedResult });
        },
      },
      conversation: {
        append: (...messages) => {
          operations.push({ type: 'append', messages });
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
    });

    expect(await generator.next()).toEqual({
      done: false,
      value: { type: 'tool_start', toolCall, toolKind: ToolKind.ReadOnly },
    });
    expect(operations).toEqual([]);

    expect(await generator.next()).toEqual({
      done: false,
      value: { type: 'tool_result', toolCall, result },
    });
    expect(operations.map((operation) => {
      if (
        typeof operation === 'object'
        && operation !== null
        && 'type' in operation
        && operation.type === 'execute'
      ) {
        return { type: 'execute' };
      }
      return operation;
    })).toEqual([
      { type: 'execute' },
      { type: 'record', result },
      { type: 'timing', turnsCount: 5, toolCallsCount: 0 },
    ]);

    expect(await generator.next()).toEqual({
      done: true,
      value: { action: 'continue' },
    });
    expect(operations).toEqual([
      { type: 'execute', executeInput: expect.any(Object) },
      { type: 'record', result },
      { type: 'timing', turnsCount: 5, toolCallsCount: 0 },
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
