import type { Message } from '@blade-ai/ai/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOOP_TURN_SAFETY_LIMIT,
  applyAgentLoopTurnLimitContinuation,
  buildAgentLoopTurnLimitContinuation,
  buildAgentLoopTurnLimitDecisionInput,
  buildAgentLoopTurnLimitDecisionInputFromHookContainer,
  buildAgentLoopTurnLimitDecisionInputFromLoopState,
  buildAgentLoopTurnLimitHooksInput,
  buildAgentLoopTurnLimitStopCompletion,
  buildAgentLoopEffectiveMaxTurns,
  decideTurnLimit,
  handleAgentLoopToolTurnTail,
  shouldApplyAgentLoopTurnLimitContinuation,
  shouldCheckAgentLoopTurnLimit,
  shouldStopAgentLoopForTurnLimitDecision,
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

describe('decideTurnLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput = {
    maxTurns: 3,
    turnsCount: 3,
    contextMessages: [{ role: 'user', content: 'Hi' }] as Message[],
    toolCallsCount: 2,
    startTime: 1_000,
    totalTokens: 321,
  };

  it('uses the configured max turns outside YOLO mode', () => {
    expect(buildAgentLoopEffectiveMaxTurns({ maxTurns: 7, isYoloMode: false })).toBe(7);
  });

  it('uses the agent safety limit in YOLO mode', () => {
    expect(buildAgentLoopEffectiveMaxTurns({ maxTurns: 7, isYoloMode: true })).toBe(
      AGENT_LOOP_TURN_SAFETY_LIMIT,
    );
  });

  it('checks the turn limit once the effective max turns are reached outside YOLO mode', () => {
    expect(
      shouldCheckAgentLoopTurnLimit({
        turnsCount: 3,
        effectiveMaxTurns: 3,
        isYoloMode: false,
      }),
    ).toBe(true);
  });

  it('does not check the turn limit before the effective max turns are reached', () => {
    expect(
      shouldCheckAgentLoopTurnLimit({
        turnsCount: 2,
        effectiveMaxTurns: 3,
        isYoloMode: false,
      }),
    ).toBe(false);
  });

  it('does not check the turn limit in YOLO mode even after the safety limit is reached', () => {
    expect(
      shouldCheckAgentLoopTurnLimit({
        turnsCount: AGENT_LOOP_TURN_SAFETY_LIMIT,
        effectiveMaxTurns: AGENT_LOOP_TURN_SAFETY_LIMIT,
        isYoloMode: true,
      }),
    ).toBe(false);
  });

  it('projects turn-limit decision input from loop state and hooks', async () => {
    const onTurnLimitReached = async () => ({ continue: false });
    const onTurnLimitCompact = async () => ({ success: false });

    expect(
      buildAgentLoopTurnLimitDecisionInput({
        ...baseInput,
        onTurnLimitReached,
        onTurnLimitCompact,
      }),
    ).toEqual({
      ...baseInput,
      onTurnLimitReached,
      onTurnLimitCompact,
    });
  });

  it('projects turn-limit decision input from loop state objects', async () => {
    const onTurnLimitReached = async () => ({ continue: false });
    const onTurnLimitCompact = async () => ({ success: false });
    const contextMessages: Message[] = [{ role: 'user', content: 'context' }];

    expect(
      buildAgentLoopTurnLimitDecisionInputFromLoopState({
        maxTurns: 5,
        turnsCount: 5,
        conversation: {
          getContextMessages: () => contextMessages,
        },
        toolResultTracker: {
          toolCallsCount: 4,
        },
        loopClock: {
          startTime: 1_000,
        },
        tokenUsageTracker: {
          totalTokens: 555,
        },
        hooks: {
          onTurnLimitReached,
          onTurnLimitCompact,
        },
      }),
    ).toEqual({
      maxTurns: 5,
      turnsCount: 5,
      contextMessages,
      toolCallsCount: 4,
      startTime: 1_000,
      totalTokens: 555,
      onTurnLimitReached,
      onTurnLimitCompact,
    });
  });

  it('projects turn-limit decision input from loop state and session hook container', async () => {
    const onTurnLimitReached = async () => ({ continue: false });
    const onTurnLimitCompact = async () => ({ success: false });
    const contextMessages: Message[] = [{ role: 'user', content: 'context' }];

    expect(
      buildAgentLoopTurnLimitDecisionInputFromHookContainer({
        maxTurns: 8,
        turnsCount: 8,
        conversation: {
          getContextMessages: () => contextMessages,
        },
        toolResultTracker: {
          toolCallsCount: 6,
        },
        loopClock: {
          startTime: 2_000,
        },
        tokenUsageTracker: {
          totalTokens: 888,
        },
        hooks: {
          turn: {
            onTurnLimitReached,
            onTurnLimitCompact,
          },
        },
      }),
    ).toEqual({
      maxTurns: 8,
      turnsCount: 8,
      contextMessages,
      toolCallsCount: 6,
      startTime: 2_000,
      totalTokens: 888,
      onTurnLimitReached,
      onTurnLimitCompact,
    });
  });

  it('projects turn-limit hooks from the session turn hook container', () => {
    const onTurnLimitReached = async () => ({ continue: false });
    const onTurnLimitCompact = async () => ({ success: false });

    expect(
      buildAgentLoopTurnLimitHooksInput({
        onTurnLimitReached,
        onTurnLimitCompact,
      }),
    ).toEqual({
      onTurnLimitReached,
      onTurnLimitCompact,
    });
  });

  it('stops with a max-turns error when no handler is provided', async () => {
    vi.setSystemTime(1_250);

    const decision = await decideTurnLimit(baseInput);

    expect(decision).toEqual({
      action: 'stop',
      result: {
        success: false,
        error: {
          type: 'max_turns_exceeded',
          message: '达到最大轮次限制 (3)',
        },
        metadata: {
          turnsCount: 3,
          toolCallsCount: 2,
          duration: 250,
          tokensUsed: 321,
        },
      },
    });
  });

  it('continues with compacted messages when the handler allows continuation and compaction succeeds', async () => {
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];
    const continueMessage: Message = { role: 'user', content: 'continue' };
    const onTurnLimitCompact = vi.fn(async (ctx: { contextMessages: Message[] }) => {
      expect(ctx).toEqual({ contextMessages: baseInput.contextMessages });
      expect(ctx).not.toHaveProperty('messages');
      return {
        success: true,
        compactedMessages,
        continueMessage,
      };
    });

    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
      onTurnLimitCompact,
    });

    expect(onTurnLimitCompact).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      action: 'compact_and_continue',
      compactedMessages,
      continueMessage,
    });
  });

  it('continues without payload when compaction is absent or fails', async () => {
    await expect(
      decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
      }),
    ).resolves.toEqual({ action: 'compact_and_continue' });

    await expect(
      decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({ success: false }),
      }),
    ).resolves.toEqual({ action: 'compact_and_continue' });
  });

  it('stops successfully when the handler chooses not to continue', async () => {
    vi.setSystemTime(1_400);

    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: false }),
    });

    expect(decision).toEqual({
      action: 'stop',
      result: {
        success: true,
        metadata: {
          turnsCount: 3,
          toolCallsCount: 2,
          duration: 400,
          tokensUsed: 321,
          configuredMaxTurns: 3,
          actualMaxTurns: 3,
        },
      },
    });
  });

  it('stops the loop only for turn-limit stop decisions', async () => {
    const stopDecision = await decideTurnLimit(baseInput);
    expect(shouldStopAgentLoopForTurnLimitDecision(stopDecision)).toBe(true);

    const continueDecision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
    });
    expect(shouldStopAgentLoopForTurnLimitDecision(continueDecision)).toBe(false);
  });

  it('builds terminal completion for turn-limit stop decisions', async () => {
    vi.setSystemTime(1_250);

    const stopDecision = await decideTurnLimit(baseInput);
    if (!shouldStopAgentLoopForTurnLimitDecision(stopDecision)) {
      throw new Error('expected a turn-limit stop decision');
    }

    expect(buildAgentLoopTurnLimitStopCompletion(stopDecision)).toEqual({
      action: 'stop',
      events: [{ type: 'agent_end' }],
      result: {
        success: false,
        error: {
          type: 'max_turns_exceeded',
          message: '达到最大轮次限制 (3)',
        },
        metadata: {
          turnsCount: 3,
          toolCallsCount: 2,
          duration: 250,
          tokensUsed: 321,
        },
      },
    });
  });

  it('builds state updates for compact-and-continue turn-limit decisions', async () => {
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];
    const continueMessage: Message = { role: 'user', content: 'continue' };

    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
      onTurnLimitCompact: async () => ({
        success: true,
        compactedMessages,
        continueMessage,
      }),
    });

    expect(buildAgentLoopTurnLimitContinuation(decision)).toEqual({
      shouldReplaceMessages: true,
      compactedMessages,
      appendMessages: [continueMessage],
    });
  });

  it('builds no state updates for turn-limit decisions without compacted messages', async () => {
    await expect(
      decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
      }).then(buildAgentLoopTurnLimitContinuation),
    ).resolves.toEqual({
      shouldReplaceMessages: false,
      compactedMessages: [],
      appendMessages: [],
    });

    await expect(decideTurnLimit(baseInput).then(buildAgentLoopTurnLimitContinuation)).resolves.toEqual({
      shouldReplaceMessages: false,
      compactedMessages: [],
      appendMessages: [],
    });
  });

  it('applies turn-limit continuation only when messages should be replaced', async () => {
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];
    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
      onTurnLimitCompact: async () => ({
        success: true,
        compactedMessages,
      }),
    });

    expect(
      shouldApplyAgentLoopTurnLimitContinuation(
        buildAgentLoopTurnLimitContinuation(decision),
      ),
    ).toBe(true);

    expect(
      shouldApplyAgentLoopTurnLimitContinuation(
        buildAgentLoopTurnLimitContinuation(await decideTurnLimit(baseInput)),
      ),
    ).toBe(false);
  });

  it('applies turn-limit continuation state updates to conversation state', async () => {
    const operations: unknown[] = [];
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];
    const continueMessage: Message = { role: 'user', content: 'continue' };
    const continuation = buildAgentLoopTurnLimitContinuation(
      await decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({
          success: true,
          compactedMessages,
          continueMessage,
        }),
      }),
    );

    if (!shouldApplyAgentLoopTurnLimitContinuation(continuation)) {
      throw new Error('expected an applicable turn-limit continuation');
    }

    const applied = applyAgentLoopTurnLimitContinuation({
      conversation: {
        replaceContent: (messages) => {
          operations.push(['replaceContent', messages]);
        },
        append: (...messages) => {
          operations.push(['append', messages]);
        },
      },
      continuation,
    });

    expect(applied).toBe(continuation);
    expect(operations).toEqual([
      ['replaceContent', compactedMessages],
      ['append', [continueMessage]],
    ]);
  });

  it('handles a tool-turn tail without turn-limit work when below the effective max turns', async () => {
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopToolTurnTail({
        signal: { aborted: false },
        loopClock: {
          startTime: 1_000,
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 1_000,
            now: 1_050,
          }),
        },
        turnsCount: 2,
        maxTurns: 4,
        effectiveMaxTurns: 4,
        isYoloMode: false,
        conversation: {
          getContextMessages: () => {
            operations.push('getContextMessages');
            return [];
          },
          replaceContent: (messages) => {
            operations.push(['replaceContent', messages]);
          },
          append: (...messages) => {
            operations.push(['append', messages]);
          },
        },
        toolResultTracker: { toolCallsCount: 3 },
        tokenUsageTracker: { totalTokens: 42 },
        turnCounter: {
          reset: () => {
            operations.push('reset');
          },
        },
      }),
    );

    expect(handled.events).toEqual([{ type: 'turn_end', turn: 2, hasToolCalls: true }]);
    expect(handled.result).toEqual({ action: 'continue' });
    expect(operations).toEqual([]);
  });

  it('handles abort after tool-turn completion before turn-limit work', async () => {
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopToolTurnTail({
        signal: { aborted: true },
        loopClock: {
          startTime: 1_000,
          resultTiming: ({ turnsCount, toolCallsCount }) => {
            operations.push(['timing', turnsCount, toolCallsCount]);
            return {
              turnsCount,
              toolCallsCount,
              startTime: 1_000,
              now: 1_075,
            };
          },
        },
        turnsCount: 3,
        maxTurns: 3,
        effectiveMaxTurns: 3,
        isYoloMode: false,
        conversation: {
          getContextMessages: () => {
            operations.push('getContextMessages');
            return [];
          },
          replaceContent: (messages) => {
            operations.push(['replaceContent', messages]);
          },
          append: (...messages) => {
            operations.push(['append', messages]);
          },
        },
        toolResultTracker: { toolCallsCount: 5 },
        tokenUsageTracker: { totalTokens: 42 },
        turnCounter: {
          reset: () => {
            operations.push('reset');
          },
        },
      }),
    );

    expect(handled.events).toEqual([
      { type: 'turn_end', turn: 3, hasToolCalls: true },
      { type: 'agent_end' },
    ]);
    expect(handled.result).toEqual({
      action: 'abort',
      result: {
        success: false,
        error: {
          type: 'aborted',
          message: '任务已被用户中止',
        },
        metadata: {
          turnsCount: 3,
          toolCallsCount: 5,
          duration: 75,
        },
      },
    });
    expect(operations).toEqual([['timing', 3, 5]]);
  });

  it('handles turn-limit compact continuations and resets the turn counter', async () => {
    const compactedMessages: Message[] = [{ role: 'assistant', content: 'summary' }];
    const continueMessage: Message = { role: 'user', content: 'continue' };
    const operations: unknown[] = [];

    const handled = await collectGenerator(
      handleAgentLoopToolTurnTail({
        signal: { aborted: false },
        loopClock: {
          startTime: 1_000,
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 1_000,
            now: 1_100,
          }),
        },
        turnsCount: 4,
        maxTurns: 4,
        effectiveMaxTurns: 4,
        isYoloMode: false,
        conversation: {
          getContextMessages: () => {
            operations.push('getContextMessages');
            return [{ role: 'user', content: 'context' }];
          },
          replaceContent: (messages) => {
            operations.push(['replaceContent', messages]);
          },
          append: (...messages) => {
            operations.push(['append', messages]);
          },
        },
        toolResultTracker: { toolCallsCount: 6 },
        tokenUsageTracker: { totalTokens: 99 },
        turnCounter: {
          reset: () => {
            operations.push('reset');
          },
        },
        hooks: {
          turn: {
            onTurnLimitReached: async ({ turnsCount }) => {
              operations.push(['reached', turnsCount]);
              return { continue: true };
            },
            onTurnLimitCompact: async ({ contextMessages }) => {
              operations.push(['compact', contextMessages]);
              return {
                success: true,
                compactedMessages,
                continueMessage,
              };
            },
          },
        },
      }),
    );

    expect(handled.events).toEqual([{ type: 'turn_end', turn: 4, hasToolCalls: true }]);
    expect(handled.result).toEqual({
      action: 'continue',
      turnLimitDecision: {
        action: 'compact_and_continue',
        compactedMessages,
        continueMessage,
      },
    });
    expect(operations).toEqual([
      'getContextMessages',
      ['reached', 4],
      ['compact', [{ role: 'user', content: 'context' }]],
      ['replaceContent', compactedMessages],
      ['append', [continueMessage]],
      'reset',
    ]);
  });
});
