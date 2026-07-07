import type { Message } from '@blade-ai/ai/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideTurnLimit } from '../loop/index.js';

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
});
