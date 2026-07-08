import type { Message } from '@blade-ai/ai/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOOP_TURN_SAFETY_LIMIT,
  buildAgentLoopTurnLimitContinuation,
  buildAgentLoopEffectiveMaxTurns,
  decideTurnLimit,
  shouldApplyAgentLoopTurnLimitContinuation,
  shouldCheckAgentLoopTurnLimit,
  shouldStopAgentLoopForTurnLimitDecision,
} from '../loop/index.js';

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
});
