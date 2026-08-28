import { describe, expect, it } from 'vitest';
import { truncateWithConfig } from '../OutputTruncator.js';

describe('OutputTruncator', () => {
  it('does not report a negative line count when only the character limit is exceeded', () => {
    const result = truncateWithConfig('x'.repeat(100), {
      maxLines: 10,
      maxChars: 40,
      keepHead: 20,
      keepTail: 20,
      summarize: false,
    });

    expect(result.truncated).toBe(true);
    expect(result.content).not.toMatch(/-\d+ lines truncated/);
    expect(result.content.length).toBeLessThanOrEqual(100);
  });

  it('does not overlap retained head and tail lines', () => {
    const result = truncateWithConfig(
      Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n'),
      {
        maxLines: 5,
        maxChars: 10_000,
        keepHead: 10,
        keepTail: 10,
        summarize: false,
      },
    );

    expect(result.content).toContain('(7 lines truncated');
    expect(result.content.match(/line-0/g)).toHaveLength(1);
    expect(result.content.match(/line-11/g)).toHaveLength(1);
  });
});
