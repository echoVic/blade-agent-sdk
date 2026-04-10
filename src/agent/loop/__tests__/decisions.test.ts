import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../services/ChatServiceInterface.js';
import { decideNoToolTurn, RETRY_PROMPT } from '../decideNoToolTurn.js';
import { decideTurnLimit } from '../decideTurnLimit.js';
import { planToolExecution } from '../planToolExecution.js';
import type { FunctionToolCall } from '../types.js';

describe('agent loop decisions', () => {
  describe('decideNoToolTurn', () => {
    it('should retry when incomplete intent is detected', async () => {
      const decision = await decideNoToolTurn('让我先检查一下：', [], 1);

      expect(decision.action).toBe('retry');
      if (decision.action === 'retry') {
        expect(decision.message.content).toBe(RETRY_PROMPT);
      }
    });

    it('should stop retrying after two retry prompts', async () => {
      const messages: Message[] = [
        { role: 'user', content: RETRY_PROMPT },
        { role: 'assistant', content: '让我先看一下：' },
        { role: 'user', content: RETRY_PROMPT },
      ];

      const decision = await decideNoToolTurn('让我开始修复：', messages, 3);

      expect(decision.action).toBe('finish');
    });

    it('should continue with reminder when stop hook asks to continue', async () => {
      const onStopCheck = vi.fn(async () => ({
        shouldStop: false,
        continueReason: 'Keep going',
      }));

      const decision = await decideNoToolTurn('First response', [], 1, onStopCheck);

      expect(decision.action).toBe('continue_with_reminder');
      if (decision.action === 'continue_with_reminder') {
        expect(decision.message.content).toContain('Keep going');
      }
    });

    it('should finish when stop hook asks to stop', async () => {
      const onStopCheck = vi.fn(async () => ({ shouldStop: true }));

      const decision = await decideNoToolTurn('Done', [], 1, onStopCheck);

      expect(decision.action).toBe('finish');
    });
  });

  describe('planToolExecution', () => {
    const toolCall = (name: string): FunctionToolCall => ({
      id: `${name}-call`,
      type: 'function',
      function: { name, arguments: '{}' },
    });

    it('should return parallel for empty calls and serial for single/multi execute calls', () => {
      const registry = { get: () => ({ kind: 'execute' }) };

      expect(planToolExecution([], registry).mode).toBe('parallel');
      expect(planToolExecution([toolCall('ReadFile')], registry).mode).toBe('serial');
      expect(
        planToolExecution([toolCall('ReadA'), toolCall('ReadB')], registry).mode,
      ).toBe('serial');
    });
  });

  describe('decideTurnLimit', () => {
    const baseInput = {
      maxTurns: 3,
      turnsCount: 3,
      messages: [{ role: 'user', content: 'Hi' }] as Message[],
      contextMessages: [{ role: 'user', content: 'Hi' }] as Message[],
      toolCallsCount: 2,
      startTime: Date.now() - 100,
      totalTokens: 321,
    };

    it('should stop when no handler is provided', async () => {
      const decision = await decideTurnLimit(baseInput);

      expect(decision.action).toBe('stop');
      if (decision.action === 'stop') {
        expect(decision.result.error?.type).toBe('max_turns_exceeded');
      }
    });

    it('should continue with compaction payload when handler returns continue and compact succeeds', async () => {
      const compactedMessages: Message[] = [{ role: 'user', content: 'Continue' }];
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
        expect(decision.result.metadata?.configuredMaxTurns).toBe(3);
      }
    });
  });
});
