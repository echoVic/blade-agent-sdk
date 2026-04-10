import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import { decideTurnLimit } from '../loop/decideTurnLimit.js';

describe('decideTurnLimit — single-writer invariants', () => {
  const baseInput = {
    maxTurns: 3,
    turnsCount: 3,
    contextMessages: [{ role: 'user', content: 'Hi' }] as Message[],
    toolCallsCount: 2,
    startTime: Date.now() - 100,
    totalTokens: 321,
  };

  it('onTurnLimitCompact receives only contextMessages, not full messages array', async () => {
    const compactHandler = vi.fn(async (ctx: { contextMessages: Message[] }) => {
      // Verify the ctx shape: only contextMessages, no 'messages' key
      expect(ctx).toHaveProperty('contextMessages');
      expect(ctx).not.toHaveProperty('messages');
      return {
        success: true,
        compactedMessages: [{ role: 'assistant' as const, content: 'summary' }],
      };
    });

    await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
      onTurnLimitCompact: compactHandler,
    });

    expect(compactHandler).toHaveBeenCalledTimes(1);
  });

  it('returns compactedMessages for AgentLoop to apply (single writer)', async () => {
    const compacted: Message[] = [{ role: 'assistant', content: 'summary' }];
    const continueMsg: Message = { role: 'user', content: 'continue' };

    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: true }),
      onTurnLimitCompact: async () => ({
        success: true,
        compactedMessages: compacted,
        continueMessage: continueMsg,
      }),
    });

    expect(decision.action).toBe('compact_and_continue');
    if (decision.action === 'compact_and_continue') {
      // The decision carries data for AgentLoop to write to ConversationState
      expect(decision.compactedMessages).toBe(compacted);
      expect(decision.continueMessage).toBe(continueMsg);
    }
  });

  it('stops when no handler is provided', async () => {
    const decision = await decideTurnLimit(baseInput);
    expect(decision.action).toBe('stop');
    if (decision.action === 'stop') {
      expect(decision.result.error?.type).toBe('max_turns_exceeded');
    }
  });

  it('stops when handler chooses not to continue', async () => {
    const decision = await decideTurnLimit({
      ...baseInput,
      onTurnLimitReached: async () => ({ continue: false }),
    });
    expect(decision.action).toBe('stop');
    if (decision.action === 'stop') {
      expect(decision.result.success).toBe(true);
    }
  });
});
