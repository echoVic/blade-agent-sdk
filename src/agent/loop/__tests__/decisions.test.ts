import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelToolCall } from '../../../model/message.js';
import { decideTurnLimit } from '../decideTurnLimit.js';
import { planToolExecution } from '../planToolExecution.js';

describe('agent loop decisions', () => {
  describe('planToolExecution', () => {
    const toolCall = (name: string): ModelToolCall => ({
      id: `${name}-call`,
      type: 'function',
      function: { name, arguments: '{}' },
    });

    it('should return parallel for empty/multi calls and serial for a single call', () => {
      expect(planToolExecution([]).mode).toBe('parallel');
      expect(planToolExecution([toolCall('ReadFile')]).mode).toBe('serial');
      expect(planToolExecution([toolCall('ReadA'), toolCall('ReadB')]).mode).toBe('parallel');
    });
  });

  describe('decideTurnLimit', () => {
    const baseInput = {
      maxTurns: 3,
      turnsCount: 3,
      totalTurnsCount: 7,
      messages: [{ role: 'user', content: 'Hi' }] as ModelMessage[],
      contextMessages: [{ role: 'user', content: 'Hi' }] as ModelMessage[],
      toolCallsCount: 2,
      startTime: Date.now() - 100,
      totalTokens: 321,
    };

    it('should stop when no handler is provided', async () => {
      const decision = await decideTurnLimit(baseInput);

      expect(decision.action).toBe('stop');
      if (decision.action === 'stop') {
        expect(decision.result.error?.type).toBe('max_turns_exceeded');
        expect(decision.result.metadata?.turnsCount).toBe(7);
      }
    });

    it('should continue with compaction payload when handler returns continue and compact succeeds', async () => {
      const compactedMessages: ModelMessage[] = [{ role: 'user', content: 'Continue' }];
      const decision = await decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({
          success: true,
          compactedMessages,
          continueMessage: { role: 'user', content: 'resume' },
        }),
      });

      expect(decision.action).toBe('compact_and_continue');
      if (decision.action === 'compact_and_continue') {
        expect(decision.compactedMessages).toEqual(compactedMessages);
        expect(decision.continueMessage?.content).toBe('resume');
      }
    });

    it('should keep compatibility when compact fails after continue', async () => {
      const decision = await decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({ success: false }),
      });

      expect(decision.action).toBe('compact_and_continue');
      if (decision.action === 'compact_and_continue') {
        expect(decision.compactedMessages).toBeUndefined();
      }
    });

    it('should stop when handler chooses not to continue', async () => {
      const decision = await decideTurnLimit({
        ...baseInput,
        onTurnLimitReached: async () => ({ continue: false }),
      });

      expect(decision.action).toBe('stop');
      if (decision.action === 'stop') {
        expect(decision.result.success).toBe(true);
        expect(decision.result.metadata?.turnsCount).toBe(7);
        expect(decision.result.metadata?.configuredMaxTurns).toBe(3);
      }
    });
  });
});
