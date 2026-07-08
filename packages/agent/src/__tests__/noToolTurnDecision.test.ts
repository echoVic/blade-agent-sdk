import type { Message } from '@blade-ai/ai/chat';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTINUE_REMINDER,
  RETRY_PROMPT,
  buildAgentLoopNoToolDecisionInput,
  buildAgentLoopNoToolDecisionInputFromConversation,
  buildAgentLoopNoToolContent,
  buildAgentLoopNoToolCompletePayload,
  buildAgentLoopNoToolContinuation,
  buildAgentLoopNoToolStopHooksInput,
  decideAgentLoopNoToolTurn,
  decideNoToolTurn,
  shouldContinueAgentLoopAfterNoToolDecision,
  shouldHandleAgentLoopNoToolTurn,
} from '../loop/index.js';

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
