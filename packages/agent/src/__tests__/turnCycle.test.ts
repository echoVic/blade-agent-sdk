import type { Message } from '@blade-ai/ai/chat';
import { describe, expect, it } from 'vitest';
import {
  createAgentLoopTurnCounter,
  handleAgentLoopTurnCycleWithEmissions,
  ToolKind,
  type AgentFunctionToolCall,
  type AgentLoopRunTurnInput,
  type AgentToolResultContentInput,
} from '../loop/index.js';
import { createAgentRecoveryAttemptTracker } from '../recovery/index.js';

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

describe('agent loop turn-cycle orchestration', () => {
  it('runs a complete tool-call turn through package-owned phases', async () => {
    const operations: unknown[] = [];
    const messages: Message[] = [{ role: 'user', content: 'read README' }];
    const turnCounter = createAgentLoopTurnCounter();
    const toolCall = makeCall('Read');
    const result: AgentToolResultContentInput = {
      success: true,
      llmContent: 'read complete',
    };
    const tokenUsageTracker = {
      totalTokens: 0,
      lastPromptTokens: 11,
      record(usage: { totalTokens?: number }) {
        operations.push({ type: 'usage_record', usage });
        this.totalTokens += usage.totalTokens ?? 0;
      },
    };
    const signal = new AbortController().signal;
    const loopClock = {
      startTime: 1_000,
      resultTiming: ({ turnsCount, toolCallsCount }: {
        turnsCount: number;
        toolCallsCount: number;
      }) => {
        operations.push({ type: 'timing', turnsCount, toolCallsCount });
        return {
          turnsCount,
          toolCallsCount,
          startTime: 1_000,
          now: 1_080,
        };
      },
    };

    const handled = await collectGenerator(
      handleAgentLoopTurnCycleWithEmissions({
        signal,
        loopClock,
        turnCounter,
        effectiveMaxTurns: 5,
        maxTurns: 5,
        isYoloMode: false,
        toolResultTracker: {
          toolCallsCount: 0,
          recentToolResults: [] as readonly AgentToolResultContentInput[],
          record(recordedResult) {
            operations.push({ type: 'record', result: recordedResult });
          },
        },
        conversation: {
          toArray: () => [...messages],
          append: (...appendedMessages) => {
            operations.push({ type: 'append', messages: appendedMessages });
            messages.push(...appendedMessages);
          },
          getContextMessages: () => {
            operations.push({ type: 'get_context_messages' });
            return messages;
          },
          replaceContent: (replacementMessages) => {
            operations.push({ type: 'replace_content', messages: replacementMessages });
            messages.splice(0, messages.length, ...replacementMessages);
          },
        },
        tokenUsageTracker,
        prepareTurnState: (turn) => {
          operations.push({ type: 'prepare', turn });
          return {
            maxContextTokens: 128000,
            executionContext: { cwd: '/tmp/project' },
            permissionMode: 'default' as const,
          };
        },
        executionPipeline: {
          getRegistry: () => ({
            get: (name: string) => name === 'Read' ? { kind: 'readonly' } : undefined,
          }),
        },
        streaming: false,
        epoch: { invalidate: () => undefined, isValid: true },
        logger: { debug: () => undefined },
        hooks: {
          turn: {
            beforeTurn: async function* (payload) {
              operations.push({ type: 'before_turn', payload });
              yield { type: 'hook_event', turn: payload.turn };
              return true;
            },
          },
          message: {
            onAssistant: async (payload) => {
              operations.push({ type: 'assistant_hook', payload });
            },
          },
          tool: {
            afterExec: async (payload) => {
              operations.push({ type: 'tool_hook', payload });
            },
          },
        },
        tracker: createAgentRecoveryAttemptTracker(),
        tokenBudget: undefined,
        runTurn: async function* (input: AgentLoopRunTurnInput<
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown
        >) {
          operations.push({ type: 'run_turn', input });
          yield { type: 'model_event', turn: 1 };
          return {
            chatResponse: {
              content: 'I will read README.',
              reasoningContent: 'Need evidence.',
              toolCalls: [toolCall],
              usage: {
                promptTokens: 7,
                completionTokens: 5,
                totalTokens: 12,
              },
            },
            streamingExecutionResults: undefined,
          };
        },
        executeToolCalls: async (executeInput) => {
          operations.push({ type: 'execute', executeInput });
          return [{ toolCall, result, toolUseUuid: 'tool-use-1' }];
        },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'hook_event', turn: 0 },
      { type: 'turn_start', turn: 1, maxTurns: 5 },
      { type: 'model_event', turn: 1 },
      {
        type: 'token_usage',
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
          maxContextTokens: 128000,
          cacheReadInputTokens: undefined,
          cacheMissInputTokens: undefined,
          billableInputTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      { type: 'thinking', content: 'Need evidence.' },
      { type: 'stream_end' },
      { type: 'tool_start', toolCall, toolKind: ToolKind.ReadOnly },
      { type: 'tool_result', toolCall, result },
      { type: 'turn_end', turn: 1, hasToolCalls: true },
    ]);
    expect(handled.result).toEqual({ action: 'continue' });
    expect(operations.map((operation) => {
      if (
        typeof operation === 'object'
        && operation !== null
        && 'type' in operation
        && (operation.type === 'run_turn' || operation.type === 'execute')
      ) {
        return { type: operation.type };
      }
      return operation;
    })).toEqual([
      {
        type: 'before_turn',
        payload: {
          turn: 0,
          messages: [{ role: 'user', content: 'read README' }],
          lastPromptTokens: 11,
        },
      },
      { type: 'prepare', turn: 1 },
      { type: 'run_turn' },
      {
        type: 'usage_record',
        usage: {
          promptTokens: 7,
          completionTokens: 5,
          totalTokens: 12,
        },
      },
      { type: 'timing', turnsCount: 1, toolCallsCount: 0 },
      {
        type: 'append',
        messages: [
          {
            role: 'assistant',
            content: 'I will read README.',
            reasoningContent: 'Need evidence.',
            tool_calls: [toolCall],
          },
        ],
      },
      {
        type: 'assistant_hook',
        payload: {
          content: 'I will read README.',
          reasoningContent: 'Need evidence.',
          toolCalls: [toolCall],
          turn: 1,
        },
      },
      { type: 'execute' },
      { type: 'record', result },
      { type: 'timing', turnsCount: 1, toolCallsCount: 0 },
      {
        type: 'tool_hook',
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
