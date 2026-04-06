import { describe, expect, it } from 'vitest';
import type { Message } from '../../../services/ChatServiceInterface.js';
import { microcompact } from '../MicrocompactStrategy.js';

describe('microcompact', () => {
  it('replaces older oversized tool outputs with compact placeholders', () => {
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 'call-1', content: 'a'.repeat(2400) },
      { role: 'tool', tool_call_id: 'call-2', content: 'b'.repeat(2300) },
      { role: 'tool', tool_call_id: 'call-3', content: 'c'.repeat(2200) },
    ];

    const result = microcompact(messages, {
      preserveRecentToolMessages: 1,
      minToolContentLength: 1000,
      previewLength: 24,
    });

    expect(result.replacedCount).toBe(2);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-1',
        content: expect.stringContaining('[Microcompact]'),
      }),
    );
    expect(result.messages[1]).toEqual(
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-2',
        content: expect.stringContaining('[Microcompact]'),
      }),
    );
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it('reports tool messages skipped because their content is not a string', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [{ type: 'text', text: 'structured tool output' }],
      },
      { role: 'tool', tool_call_id: 'call-2', content: 'b'.repeat(2300) },
    ];

    const result = microcompact(messages, {
      preserveRecentToolMessages: 0,
      minToolContentLength: 1000,
      previewLength: 24,
    });

    expect(result.skippedNonStringToolMessages).toBe(1);
    expect(result.replacedCount).toBe(1);
    expect(result.messages[0]).toEqual(messages[0]);
  });
});
