import { describe, expect, it } from 'vitest';
import { markToolInjectedSystemMessages } from '../state/toolInjectedMessages.js';

describe('tool-injected message projection', () => {
  it('marks system messages from tools while preserving existing metadata', () => {
    const messages = markToolInjectedSystemMessages([
      {
        role: 'system',
        content: 'system context',
        metadata: { keep: true },
      },
      {
        role: 'assistant',
        content: 'assistant context',
        metadata: { keep: true },
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'system',
        content: 'system context',
        metadata: { keep: true, _systemSource: 'tool_injection' },
      },
      {
        role: 'assistant',
        content: 'assistant context',
        metadata: { keep: true },
      },
    ]);
  });

  it('replaces non-object system metadata with the tool injection source marker', () => {
    expect(
      markToolInjectedSystemMessages([
        { role: 'system', content: 'system context', metadata: 'external' },
      ]),
    ).toEqual([
      {
        role: 'system',
        content: 'system context',
        metadata: { _systemSource: 'tool_injection' },
      },
    ]);
  });
});
