import type { Message } from '@blade-ai/ai/chat';
import { describe, expect, it } from 'vitest';
import {
  handleAgentLoopWithEmissions,
  type AgentLoopRunTurnInput,
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

describe('agent loop orchestration', () => {
  it('runs the package-owned loop skeleton with injected runtime ports', async () => {
    const operations: unknown[] = [];
    const messages: Message[] = [{ role: 'user', content: 'finish this' }];

    const handled = await collectGenerator(
      handleAgentLoopWithEmissions({
        streaming: false,
        executionPipeline: {
          getRegistry: () => ({
            get: () => undefined,
          }),
        },
        conversation: {
          toArray: () => [...messages],
          append: (...appendedMessages) => {
            operations.push({ type: 'append', messages: appendedMessages });
            messages.push(...appendedMessages);
          },
          getContextMessages: () => {
            operations.push({ type: 'get_context_messages' });
            return [...messages];
          },
          replaceContent: (replacementMessages) => {
            operations.push({ type: 'replace_content', messages: replacementMessages });
            messages.splice(0, messages.length, ...replacementMessages);
          },
        },
        maxTurns: 5,
        isYoloMode: false,
        prepareTurnState: (turn) => {
          operations.push({ type: 'prepare', turn });
          return {
            maxContextTokens: 128000,
            executionContext: { cwd: '/tmp/project' },
            permissionMode: 'default' as const,
          };
        },
        createEpoch: () => {
          operations.push({ type: 'create_epoch' });
          return {
            invalidate: () => {
              operations.push({ type: 'invalidate_epoch' });
            },
            isValid: true,
          };
        },
        logger: { debug: () => undefined },
        hooks: {
          message: {
            onComplete: async (payload) => {
              operations.push({ type: 'complete_hook', payload });
            },
          },
        },
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
              content: 'Done.',
              toolCalls: [],
              usage: {
                promptTokens: 4,
                completionTokens: 2,
                totalTokens: 6,
              },
            },
            streamingExecutionResults: undefined,
          };
        },
        executeToolCalls: async () => {
          throw new Error('executeToolCalls should not run for no-tool completion');
        },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'agent_start' },
      { type: 'turn_start', turn: 1, maxTurns: 5 },
      { type: 'model_event', turn: 1 },
      {
        type: 'token_usage',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          maxContextTokens: 128000,
          cacheReadInputTokens: undefined,
          cacheMissInputTokens: undefined,
          billableInputTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      { type: 'stream_end' },
      { type: 'turn_end', turn: 1, hasToolCalls: false },
      { type: 'agent_end' },
    ]);
    expect(handled.result).toEqual({
      success: true,
      finalMessage: 'Done.',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        tokensUsed: 6,
        duration: expect.any(Number),
        tokenBudget: undefined,
      },
    });
    expect(operations.map((operation) => {
      if (
        typeof operation === 'object'
        && operation !== null
        && 'type' in operation
        && operation.type === 'run_turn'
      ) {
        return { type: operation.type };
      }
      return operation;
    })).toEqual([
      { type: 'create_epoch' },
      { type: 'prepare', turn: 1 },
      { type: 'run_turn' },
      {
        type: 'complete_hook',
        payload: {
          content: 'Done.',
          turn: 1,
        },
      },
    ]);
  });
});
