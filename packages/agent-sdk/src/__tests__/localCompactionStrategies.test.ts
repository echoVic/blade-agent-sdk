import { describe, expect, it } from 'vitest';
import {
  microcompact,
  type MicrocompactOptions,
  type MicrocompactResult,
  softCompact,
  type SoftCompactionOptions,
  type SoftCompactionResult,
} from '../local/index.js';

describe('microcompact strategy', () => {
  it('returns messages unchanged when no tool messages match', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    const result = microcompact(messages);
    expect(result.messages).toEqual(messages);
    expect(result.replacedCount).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it('replaces large tool messages with microcompact preview', () => {
    const longContent = 'x'.repeat(2000);
    const messages = [
      { role: 'tool' as const, content: longContent, tool_call_id: 'tc_1' },
    ];
    const result = microcompact(messages, { minToolContentLength: 100, preserveRecentToolMessages: 0 });
    expect(result.replacedCount).toBe(1);
    expect(result.savedChars).toBeGreaterThan(0);
    expect(result.messages[0].content).toContain('[Microcompact]');
    expect(result.messages[0].content).toContain('tc_1');
  });

  it('preserves recent tool messages via preserveRecentToolMessages', () => {
    const longContent = 'x'.repeat(2000);
    const messages = [
      { role: 'tool' as const, content: longContent, tool_call_id: 'tc_1' },
      { role: 'tool' as const, content: longContent, tool_call_id: 'tc_2' },
      { role: 'tool' as const, content: longContent, tool_call_id: 'tc_3' },
    ];
    const result = microcompact(messages, {
      minToolContentLength: 100,
      preserveRecentToolMessages: 2,
    });
    // The last 2 tool messages should be preserved
    expect(result.messages[0].content).toContain('[Microcompact]');
    expect(result.messages[1].content).toBe(longContent);
    expect(result.messages[2].content).toBe(longContent);
    expect(result.replacedCount).toBe(1);
  });

  it('skips messages with non-string tool content', () => {
    const messages = [
      { role: 'tool' as const, content: [{ type: 'text' as const, text: 'x'.repeat(2000) }], tool_call_id: 'tc_1' },
    ];
    const result = microcompact(messages, { minToolContentLength: 100 });
    expect(result.replacedCount).toBe(0);
    expect(result.skippedNonStringToolMessages).toBe(1);
  });
});

describe('softCompact strategy', () => {
  it('returns messages unchanged when all are under limit', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'tool' as const, content: 'short result' },
    ];
    const result = softCompact(messages);
    expect(result.messages).toEqual(messages);
    expect(result.truncatedCount).toBe(0);
    expect(result.savedChars).toBe(0);
  });

  it('truncates tool messages exceeding maxToolResultLength', () => {
    const longContent = 'z'.repeat(3000);
    const messages = [
      { role: 'tool' as const, content: longContent, tool_call_id: 'tc_1' },
    ];
    const result = softCompact(messages, { maxToolResultLength: 2000 });
    expect(result.truncatedCount).toBe(1);
    expect(result.savedChars).toBe(1000);
    expect(result.messages[0].content).toContain('truncated');
  });
});
