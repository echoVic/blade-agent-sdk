import { describe, expect, it, vi } from 'vitest';
import { HookEvent } from '../../types/constants.js';
import { SessionId } from '../../types/identifiers.js';
import { HookDispatcher } from '../HookDispatcher.js';

describe('HookDispatcher', () => {
  it('uses the supported inline event set as the only hook event registry', () => {
    expect(Object.values(HookEvent)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'TaskCompleted',
    ]);
  });

  it('dispatches callbacks in registration order through one lifecycle', async () => {
    const calls: string[] = [];
    const dispatcher = new HookDispatcher({
      [HookEvent.UserPromptSubmit]: [
        vi.fn(async () => {
          calls.push('first');
          return { action: 'continue' as const };
        }),
        vi.fn(async () => {
          calls.push('second');
          return { action: 'continue' as const, modifiedInput: { userPrompt: 'updated' } };
        }),
      ],
    });

    const outputs = await dispatcher.dispatch(
      HookEvent.UserPromptSubmit,
      {
        event: HookEvent.UserPromptSubmit,
        sessionId: SessionId('dispatcher-test'),
        userPrompt: 'original',
      },
      { timeoutMs: 1_000 },
    );

    expect(calls).toEqual(['first', 'second']);
    expect(outputs).toEqual([
      { action: 'continue' },
      { action: 'continue', modifiedInput: { userPrompt: 'updated' } },
    ]);
  });
});
