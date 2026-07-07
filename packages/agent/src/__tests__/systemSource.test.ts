import { describe, expect, it } from 'vitest';
import {
  VALID_SYSTEM_SOURCES,
  isValidSystemSource,
  type SystemSource,
} from '../state/index.js';

describe('agent state system source helpers', () => {
  it('exposes the controlled system-source values', () => {
    expect([...VALID_SYSTEM_SOURCES]).toEqual([
      'catalog',
      'tool_injection',
      'compaction_summary',
    ]);
  });

  it.each<[unknown, boolean]>([
    ['catalog', true],
    ['tool_injection', true],
    ['compaction_summary', true],
    ['unknown', false],
    ['', false],
    ['CATALOG', false],
    [null, false],
    [undefined, false],
    [42, false],
    [true, false],
    [{ catalog: true }, false],
  ])('checks whether %j is a valid system source', (input, expected) => {
    expect(isValidSystemSource(input)).toBe(expected);
  });

  it('narrows valid values to the SystemSource type', () => {
    const value: unknown = 'catalog';

    if (isValidSystemSource(value)) {
      const source: SystemSource = value;
      expect(source).toBe('catalog');
    }
  });
});
