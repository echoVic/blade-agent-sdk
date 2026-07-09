import type { Message } from '@blade-ai/ai/chat';
import { describe, expect, it } from 'vitest';
import {
  handleAgentLoopModelResponseWithEmissions,
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

describe('agent loop model response turn orchestration', () => {
  it('records usage, emits response events, appends tool-call assistant message, and continues to tools', async () => {
    const operations: unknown[] = [];
    const messages: Message[] = [{ role: 'user', content: 'read the README' }];
    const toolCalls = [
      {
        id: 'call_read',
        type: 'function' as const,
        function: {
          name: 'Read',
          arguments: '{"file":"README.md"}',
        },
      },
    ];
    const tokenUsageTracker = {
      totalTokens: 0,
      record(usage: { totalTokens?: number }) {
        operations.push({ type: 'usage_record', usage });
        this.totalTokens += usage.totalTokens ?? 0;
      },
    };

    const handled = await collectGenerator(
      handleAgentLoopModelResponseWithEmissions({
        response: {
          content: 'I will inspect README.md.',
          reasoningContent: 'Need project evidence.',
          toolCalls,
          usage: {
            promptTokens: 9,
            completionTokens: 5,
            totalTokens: 14,
          },
        },
        streamingExecutionResults: undefined,
        conversation: {
          toArray: () => messages,
          append: (...appendedMessages) => {
            operations.push({ type: 'append', messages: appendedMessages });
            messages.push(...appendedMessages);
          },
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
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 1000,
            now: 1100,
          }),
        },
        turnsCount: 2,
        toolResultTracker: { toolCallsCount: 0 },
        tokenUsageTracker,
        turnCounter: {
          turnsCount: 2,
          previousCompletedTurnCount: 2,
        },
        hooks: {
          message: {
            onAssistant: async (payload) => {
              operations.push({ type: 'assistant_hook', payload });
            },
          },
        },
      }),
    );

    expect(handled.result).toEqual({ action: 'continue_tool' });
    expect(handled.events).toEqual([
      {
        type: 'token_usage',
        usage: {
          inputTokens: 9,
          outputTokens: 5,
          totalTokens: 14,
          maxContextTokens: 128000,
          cacheReadInputTokens: undefined,
          cacheMissInputTokens: undefined,
          billableInputTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      {
        type: 'thinking',
        content: 'Need project evidence.',
      },
      {
        type: 'stream_end',
      },
    ]);
    expect(operations).toEqual([
      {
        type: 'usage_record',
        usage: {
          promptTokens: 9,
          completionTokens: 5,
          totalTokens: 14,
        },
      },
      {
        type: 'append',
        messages: [
          {
            role: 'assistant',
            content: 'I will inspect README.md.',
            reasoningContent: 'Need project evidence.',
            tool_calls: toolCalls,
          },
        ],
      },
      {
        type: 'assistant_hook',
        payload: {
          content: 'I will inspect README.md.',
          reasoningContent: 'Need project evidence.',
          toolCalls,
          turn: 2,
        },
      },
    ]);
  });
});
