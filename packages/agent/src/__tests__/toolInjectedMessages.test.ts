import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopToolInjectedMessages,
  shouldAppendAgentLoopToolInjectedMessages,
} from '../loop/index.js';
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

  it('projects tool result newMessages for agent loop storage', () => {
    expect(buildAgentLoopToolInjectedMessages({ newMessages: undefined })).toEqual([]);
    expect(buildAgentLoopToolInjectedMessages({ newMessages: [] })).toEqual([]);

    expect(
      buildAgentLoopToolInjectedMessages({
        newMessages: [
          { role: 'system', content: 'tool context' },
          { role: 'user', content: 'follow-up context' },
        ],
      }),
    ).toEqual([
      {
        role: 'system',
        content: 'tool context',
        metadata: { _systemSource: 'tool_injection' },
      },
      { role: 'user', content: 'follow-up context' },
    ]);
  });

  it('selects append behavior only when projected tool-injected messages are present', () => {
    expect(shouldAppendAgentLoopToolInjectedMessages([])).toBe(false);
    expect(
      shouldAppendAgentLoopToolInjectedMessages([
        { role: 'system' },
      ]),
    ).toBe(true);
  });
});
