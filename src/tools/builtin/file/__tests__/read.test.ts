import { describe, expect, it } from 'vitest';
import { truncateTextLine } from '../read.js';

describe('truncateTextLine', () => {
  it('never splits a Unicode surrogate pair', () => {
    const value = `${'a'.repeat(1999)}😀tail`;
    const truncated = truncateTextLine(value);

    expect(truncated).toBe(`${'a'.repeat(1999)}😀...`);
    expect(truncated).not.toContain('\uFFFD');
  });
});
