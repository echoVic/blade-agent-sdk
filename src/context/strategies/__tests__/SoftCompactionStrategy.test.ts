import { describe, expect, it } from 'vitest';
import type { Message } from '../../../services/ChatServiceInterface.js';
import { softCompact } from '../SoftCompactionStrategy.js';

describe('softCompact', () => {
  it('truncates tool messages exceeding maxToolResultLength', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'a'.repeat(25) },
    ];

    const result = softCompact(messages, { maxToolResultLength: 10 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'tool',
      content: 'aaaaaaaaaa\n\n[...truncated, original length: 25 chars]',
    });
    expect(result.truncatedCount).toBe(1);
  });

  it('preserves non-tool messages unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
      { role: 'assistant', content: 'assistant' },
      { role: 'tool', content: 'small' },
    ];

    const result = softCompact(messages, { maxToolResultLength: 10 });

    expect(result.messages).toEqual(messages);
    expect(result.truncatedCount).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it('counts truncated messages and saved chars correctly', () => {
    const messages: Message[] = [
      { role: 'tool', content: '12345678901234567890' },
      { role: 'tool', content: 'abcdefghijklmno' },
      { role: 'assistant', content: 'keep me' },
    ];

    const result = softCompact(messages, { maxToolResultLength: 10 });

    expect(result.truncatedCount).toBe(2);
    expect(result.savedChars).toBe(15);
  });

  it('handles empty messages array', () => {
    const result = softCompact([]);

    expect(result).toEqual({
      messages: [],
      truncatedCount: 0,
      savedChars: 0,
    });
  });

  it('respects custom maxToolResultLength option', () => {
    const messages: Message[] = [
      { role: 'tool', content: '1234567890' },
    ];

    const result = softCompact(messages, { maxToolResultLength: 5 });

    expect(result.messages[0]).toEqual({
      role: 'tool',
      content: '12345\n\n[...truncated, original length: 10 chars]',
    });
    expect(result.savedChars).toBe(5);
  });
});
