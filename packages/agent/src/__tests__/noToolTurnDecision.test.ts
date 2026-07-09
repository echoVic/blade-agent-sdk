import type { Message } from '@blade-ai/ai/chat';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTINUE_REMINDER,
  RETRY_PROMPT,
  applyAgentLoopNoToolContinuation,
  buildAgentLoopNoToolDecisionInput,
  buildAgentLoopNoToolDecisionInputFromConversation,
  buildAgentLoopNoToolDecisionInputFromHookContainer,
  buildAgentLoopNoToolContent,
  buildAgentLoopNoToolCompletePayload,
  buildAgentLoopNoToolContinuation,
  buildAgentLoopNoToolStopHooksInput,
  decideAgentLoopNoToolTurn,
  decideNoToolTurn,
  handleAgentLoopNoToolTurn,
  handleAgentLoopResponseNoToolGateWithEmissions,
  handleAgentLoopNoToolTurnWithEmissions,
  runAgentLoopNoToolCompleteHook,
  shouldContinueAgentLoopAfterNoToolDecision,
  shouldHandleAgentLoopNoToolTurn,
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

describe('decideNoToolTurn', () => {
  it('detects responses that should follow the no-tool branch', () => {
    expect(shouldHandleAgentLoopNoToolTurn({})).toBe(true);
    expect(shouldHandleAgentLoopNoToolTurn({ toolCalls: [] })).toBe(true);
    expect(
      shouldHandleAgentLoopNoToolTurn({
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('normalizes missing no-tool response content to an empty string', () => {
    expect(buildAgentLoopNoToolContent({ content: 'All done' })).toBe('All done');
    expect(buildAgentLoopNoToolContent({ content: '' })).toBe('');
    expect(buildAgentLoopNoToolContent({ content: undefined })).toBe('');
  });

  it('continues the loop only for retry or reminder no-tool decisions', () => {
    expect(
      shouldContinueAgentLoopAfterNoToolDecision({
        action: 'retry',
        message: { role: 'user', content: RETRY_PROMPT },
      }),
    ).toBe(true);
    expect(
      shouldContinueAgentLoopAfterNoToolDecision({
        action: 'continue_with_reminder',
        message: { role: 'user', content: DEFAULT_CONTINUE_REMINDER },
      }),
    ).toBe(true);
    expect(shouldContinueAgentLoopAfterNoToolDecision({ action: 'finish' })).toBe(false);
  });

  it('projects a no-tool continuation into the message append and turn-end event', () => {
    const message: Message = { role: 'user', content: DEFAULT_CONTINUE_REMINDER };

    expect(
      buildAgentLoopNoToolContinuation({
        decision: { action: 'continue_with_reminder', message, warning: 'keep-working' },
        turn: 3,
      }),
    ).toEqual({
      action: 'continue',
      message,
      warning: 'keep-working',
      events: [{ type: 'turn_end', turn: 3, hasToolCalls: false }],
    });
  });

  it('applies a no-tool continuation to conversation state', () => {
    const appendedMessages: Message[] = [];
    const message: Message = { role: 'user', content: DEFAULT_CONTINUE_REMINDER };
    const continuation = buildAgentLoopNoToolContinuation({
      decision: { action: 'continue_with_reminder', message, warning: 'keep-working' },
      turn: 3,
    });

    const applied = applyAgentLoopNoToolContinuation({
      conversation: {
        append: (...messages) => {
          appendedMessages.push(...messages);
        },
      },
      continuation,
    });

    expect(applied).toBe(continuation);
    expect(appendedMessages).toEqual([message]);
    expect(applied.events).toEqual([{ type: 'turn_end', turn: 3, hasToolCalls: false }]);
    expect(applied.warning).toBe('keep-working');
  });

  it('projects a no-tool completion payload for message hooks', () => {
    expect(
      buildAgentLoopNoToolCompletePayload({
        content: 'All done',
        turn: 5,
      }),
    ).toEqual({
      content: 'All done',
      turn: 5,
    });
  });

  it('runs no-tool completion hooks from the session hook container', async () => {
    const calls: unknown[] = [];

    const payload = await runAgentLoopNoToolCompleteHook({
      content: 'All done',
      turn: 5,
      hooks: {
        message: {
          onComplete: async (hookPayload) => {
            calls.push(hookPayload);
          },
        },
      },
    });

    expect(payload).toEqual({
      content: 'All done',
      turn: 5,
    });
    expect(calls).toEqual([payload]);
  });

  it('handles no-tool continuation decisions with append-before-return ordering', async () => {
    const operations: unknown[] = [];
    const check = vi.fn(async () => {
      operations.push({ type: 'stop_check' });
      return {
        shouldStop: false,
        continueReason: 'Keep using the existing roadmap.',
        warning: 'still-working',
      };
    });
    const messages: Message[] = [{ role: 'user', content: 'continue' }];

    const handling = await handleAgentLoopNoToolTurn({
      response: { content: 'I will continue' },
      conversation: {
        toArray: () => {
          operations.push({ type: 'to_array' });
          return messages;
        },
        append: (...appendedMessages) => {
          operations.push({ type: 'append', messages: appendedMessages });
        },
      },
      turn: 4,
      hooks: {
        stop: {
          check,
        },
      },
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => ({
          turnsCount,
          toolCallsCount,
          startTime: 1000,
          now: 1100,
        }),
      },
      toolResultTracker: { toolCallsCount: 2 },
      tokenUsageTracker: { totalTokens: 21 },
    });

    expect(handling.action).toBe('continue');
    if (handling.action === 'continue') {
      expect(handling.content).toBe('I will continue');
      expect(handling.continuation.warning).toBe('still-working');
      expect(handling.continuation.message.content).toContain(
        'Keep using the existing roadmap.',
      );
      expect(handling.continuation.events).toEqual([
        { type: 'turn_end', turn: 4, hasToolCalls: false },
      ]);
      expect(operations).toEqual([
        { type: 'to_array' },
        { type: 'stop_check' },
        { type: 'append', messages: [handling.continuation.message] },
      ]);
    }
  });

  it('handles no-tool continuation emissions and returns a continue action', async () => {
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopNoToolTurnWithEmissions({
        response: { content: 'I will continue' },
        conversation: {
          toArray: () => {
            operations.push({ type: 'to_array' });
            return [{ role: 'user', content: 'continue' }];
          },
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
        },
        turn: 4,
        hooks: {
          stop: {
            check: async () => {
              operations.push({ type: 'stop_check' });
              return {
                shouldStop: false,
                continueReason: 'Keep using the existing roadmap.',
              };
            },
          },
        },
        loopClock: {
          resultTiming: () => {
            throw new Error('finish timing should not be read for continuations');
          },
        },
        toolResultTracker: { toolCallsCount: 2 },
        tokenUsageTracker: { totalTokens: 21 },
      }),
    );

    expect(handled.events).toEqual([{ type: 'turn_end', turn: 4, hasToolCalls: false }]);
    expect(handled.result).toEqual({ action: 'continue' });
    expect(operations).toEqual([
      { type: 'to_array' },
      { type: 'stop_check' },
      {
        type: 'append',
        messages: [
          {
            role: 'user',
            content: '\n\n<system-reminder>\nKeep using the existing roadmap.\n</system-reminder>',
          },
        ],
      },
    ]);
  });

  it('handles no-tool finish decisions with hook-before-success ordering', async () => {
    const operations: unknown[] = [];
    const snapshot = { usedTokens: 21, maxTokens: 100 };

    const handling = await handleAgentLoopNoToolTurn({
      response: {},
      conversation: {
        toArray: () => {
          operations.push({ type: 'to_array' });
          return [];
        },
        append: (...messages) => {
          operations.push({ type: 'append', messages });
        },
      },
      turn: 5,
      hooks: {
        message: {
          onComplete: async (payload) => {
            operations.push({ type: 'complete_hook', payload });
          },
        },
      },
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => {
          operations.push({ type: 'timing', turnsCount, toolCallsCount });
          return {
            turnsCount,
            toolCallsCount,
            startTime: 2000,
            now: 2075,
          };
        },
      },
      toolResultTracker: { toolCallsCount: 3 },
      tokenUsageTracker: { totalTokens: 21 },
      tokenBudget: {
        getSnapshot: () => snapshot,
      },
    });

    expect(handling).toEqual({
      action: 'finish',
      content: '',
      decision: { action: 'finish' },
      completionPayload: { content: '', turn: 5 },
      successDecision: {
        action: 'finish',
        events: [
          { type: 'turn_end', turn: 5, hasToolCalls: false },
          { type: 'agent_end' },
        ],
        result: {
          success: true,
          finalMessage: '',
          metadata: {
            turnsCount: 5,
            toolCallsCount: 3,
            duration: 75,
            tokensUsed: 21,
            tokenBudgetSnapshot: snapshot,
          },
        },
      },
    });
    expect(operations).toEqual([
      { type: 'to_array' },
      { type: 'complete_hook', payload: { content: '', turn: 5 } },
      { type: 'timing', turnsCount: 5, toolCallsCount: 3 },
    ]);
  });

  it('handles no-tool finish emissions and returns the success result', async () => {
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopNoToolTurnWithEmissions({
        response: { content: 'All done' },
        conversation: {
          toArray: () => {
            operations.push({ type: 'to_array' });
            return [];
          },
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
        },
        turn: 5,
        hooks: {
          message: {
            onComplete: async (payload) => {
              operations.push({ type: 'complete_hook', payload });
            },
          },
        },
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => {
            operations.push({ type: 'timing', turnsCount, toolCallsCount });
            return {
              turnsCount,
              toolCallsCount,
              startTime: 2000,
              now: 2075,
            };
          },
        },
        toolResultTracker: { toolCallsCount: 3 },
        tokenUsageTracker: { totalTokens: 21 },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'turn_end', turn: 5, hasToolCalls: false },
      { type: 'agent_end' },
    ]);
    expect(handled.result).toEqual({
      action: 'finish',
      result: {
        success: true,
        finalMessage: 'All done',
        metadata: {
          turnsCount: 5,
          toolCallsCount: 3,
          duration: 75,
          tokensUsed: 21,
          tokenBudgetSnapshot: undefined,
        },
      },
    });
    expect(operations).toEqual([
      { type: 'to_array' },
      { type: 'complete_hook', payload: { content: 'All done', turn: 5 } },
      { type: 'timing', turnsCount: 5, toolCallsCount: 3 },
    ]);
  });

  it('handles response no-tool gates by continuing to tool handling for tool calls', async () => {
    const handled = await collectGenerator(
      handleAgentLoopResponseNoToolGateWithEmissions({
        response: {
          content: 'I will call a tool',
          reasoningContent: 'Need the file first.',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'Read', arguments: '{}' },
            },
          ],
        },
        streamingExecutionResults: undefined,
        signal: undefined,
        conversation: {
          toArray: () => {
            throw new Error('tool-call responses should not inspect no-tool history');
          },
          append: () => {
            throw new Error('tool-call responses should not append no-tool messages');
          },
        },
        turn: 6,
        hooks: {},
        loopClock: {
          resultTiming: () => {
            throw new Error('tool-call responses should not build no-tool results');
          },
        },
        toolResultTracker: { toolCallsCount: 2 },
        tokenUsageTracker: { totalTokens: 21 },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'thinking', content: 'Need the file first.' },
      { type: 'stream_end' },
    ]);
    expect(handled.result).toEqual({ action: 'continue_tool' });
  });

  it('handles response no-tool gates by emitting response events before no-tool continuation', async () => {
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopResponseNoToolGateWithEmissions({
        response: {
          content: 'I will continue',
          reasoningContent: 'Need one more step.',
        },
        streamingExecutionResults: undefined,
        signal: undefined,
        conversation: {
          toArray: () => {
            operations.push({ type: 'to_array' });
            return [{ role: 'user', content: 'continue' }];
          },
          append: (...messages) => {
            operations.push({ type: 'append', messages });
          },
        },
        turn: 4,
        hooks: {
          stop: {
            check: async () => {
              operations.push({ type: 'stop_check' });
              return {
                shouldStop: false,
                continueReason: 'Keep moving.',
              };
            },
          },
        },
        loopClock: {
          resultTiming: () => {
            throw new Error('continuations should not build finish timing');
          },
        },
        toolResultTracker: { toolCallsCount: 2 },
        tokenUsageTracker: { totalTokens: 21 },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'thinking', content: 'Need one more step.' },
      { type: 'stream_end' },
      { type: 'turn_end', turn: 4, hasToolCalls: false },
    ]);
    expect(handled.result).toEqual({ action: 'continue_loop' });
    expect(operations).toEqual([
      { type: 'to_array' },
      { type: 'stop_check' },
      {
        type: 'append',
        messages: [
          {
            role: 'user',
            content: '\n\n<system-reminder>\nKeep moving.\n</system-reminder>',
          },
        ],
      },
    ]);
  });

  it('handles response no-tool gates by returning finish results after response events', async () => {
    const handled = await collectGenerator(
      handleAgentLoopResponseNoToolGateWithEmissions({
        response: { content: 'All done' },
        streamingExecutionResults: undefined,
        signal: undefined,
        conversation: {
          toArray: () => [],
          append: () => {
            throw new Error('finish responses should not append continuation messages');
          },
        },
        turn: 5,
        hooks: {},
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 2000,
            now: 2075,
          }),
        },
        toolResultTracker: { toolCallsCount: 3 },
        tokenUsageTracker: { totalTokens: 21 },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'stream_end' },
      { type: 'turn_end', turn: 5, hasToolCalls: false },
      { type: 'agent_end' },
    ]);
    expect(handled.result).toEqual({
      action: 'finish',
      result: {
        success: true,
        finalMessage: 'All done',
        metadata: {
          turnsCount: 5,
          toolCallsCount: 3,
          duration: 75,
          tokensUsed: 21,
          tokenBudgetSnapshot: undefined,
        },
      },
    });
  });

  it('projects object-style no-tool decision input and runs the decision wrapper', async () => {
    const messages: Message[] = [{ role: 'user', content: 'continue' }];
    const onStopCheck = vi.fn(async () => ({ shouldStop: true }));

    const input = buildAgentLoopNoToolDecisionInput({
      content: 'All done',
      messages,
      turn: 7,
      onStopCheck,
    });

    expect(input).toEqual({
      content: 'All done',
      messages,
      turn: 7,
      onStopCheck,
    });
    await expect(decideAgentLoopNoToolTurn(input)).resolves.toEqual({ action: 'finish' });
    expect(onStopCheck).toHaveBeenCalledWith({ content: 'All done', turn: 7 });
  });

  it('projects no-tool decision input from conversation state and stop hooks', () => {
    const messages: Message[] = [{ role: 'user', content: 'continue' }];
    const check = vi.fn(async () => ({ shouldStop: true }));
    const conversation = {
      toArray: () => messages,
    };

    expect(
      buildAgentLoopNoToolDecisionInputFromConversation({
        content: 'All done',
        conversation,
        turn: 7,
        check,
      }),
    ).toEqual({
      content: 'All done',
      messages,
      turn: 7,
      onStopCheck: check,
    });
  });

  it('projects no-tool decision input from conversation state and session hook container', () => {
    const messages: Message[] = [{ role: 'user', content: 'continue' }];
    const check = vi.fn(async () => ({ shouldStop: true }));
    const conversation = {
      toArray: () => messages,
    };

    expect(
      buildAgentLoopNoToolDecisionInputFromHookContainer({
        content: 'All done',
        conversation,
        turn: 7,
        hooks: {
          stop: {
            check,
          },
        },
      }),
    ).toEqual({
      content: 'All done',
      messages,
      turn: 7,
      onStopCheck: check,
    });
  });

  it('projects no-tool stop hooks from the session stop hook container', () => {
    const check = vi.fn(async () => ({ shouldStop: true }));

    expect(buildAgentLoopNoToolStopHooksInput({ check })).toEqual({
      onStopCheck: check,
    });
  });

  it.each([
    '让我先检查一下：',
    '让我开始修复：',
    'Let me check the files first',
    'Planning...',
  ])('retries when assistant content implies unfinished action: %s', async (content) => {
    const decision = await decideNoToolTurn(content, [], 1);

    expect(decision).toEqual({
      action: 'retry',
      message: { role: 'user', content: RETRY_PROMPT },
    });
  });

  it('stops retrying after two recent retry prompts', async () => {
    const messages: Message[] = [
      { role: 'user', content: RETRY_PROMPT },
      { role: 'assistant', content: '让我先看一下：' },
      { role: 'user', content: RETRY_PROMPT },
    ];

    await expect(decideNoToolTurn('让我开始修复：', messages, 3)).resolves.toEqual({
      action: 'finish',
    });
  });

  it('continues with a default reminder when the stop hook asks to continue without a reason', async () => {
    const onStopCheck = vi.fn(async () => ({ shouldStop: false }));

    const decision = await decideNoToolTurn('Done for now', [], 2, onStopCheck);

    expect(onStopCheck).toHaveBeenCalledWith({ content: 'Done for now', turn: 2 });
    expect(decision).toEqual({
      action: 'continue_with_reminder',
      message: { role: 'user', content: DEFAULT_CONTINUE_REMINDER },
      warning: undefined,
    });
  });

  it('continues with a custom reminder and warning when provided by the stop hook', async () => {
    const onStopCheck = vi.fn(async () => ({
      shouldStop: false,
      continueReason: 'Keep executing the migration checklist',
      warning: 'still-working',
    }));

    const decision = await decideNoToolTurn('I will continue', [], 4, onStopCheck);

    expect(decision.action).toBe('continue_with_reminder');
    if (decision.action === 'continue_with_reminder') {
      expect(decision.message.content).toContain('Keep executing the migration checklist');
      expect(decision.warning).toBe('still-working');
    }
  });

  it('finishes when there is no retry need and no stop hook asks to continue', async () => {
    await expect(decideNoToolTurn('All done', [], 1)).resolves.toEqual({
      action: 'finish',
    });
  });

  it('finishes when the stop hook asks to stop', async () => {
    const onStopCheck = vi.fn(async () => ({ shouldStop: true }));

    await expect(decideNoToolTurn('Done', [], 1, onStopCheck)).resolves.toEqual({
      action: 'finish',
    });
  });
});
