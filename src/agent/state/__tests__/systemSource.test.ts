import { describe, expect, it } from 'vitest';
import {
  VALID_SYSTEM_SOURCES,
  isValidSystemSource,
  type SystemSource,
} from '../systemSource.js';

describe('systemSource controlled enum', () => {
  describe('VALID_SYSTEM_SOURCES', () => {
    it('contains exactly the three expected values', () => {
      expect([...VALID_SYSTEM_SOURCES]).toEqual([
        'catalog',
        'tool_injection',
        'compaction_summary',
      ]);
    });
  });

  describe('isValidSystemSource', () => {
    it.each<[unknown, boolean]>([
      ['catalog', true],
      ['tool_injection', true],
      ['compaction_summary', true],
      ['unknown', false],
      ['', false],
      ['CATALOG', false],       // case-sensitive
      [null, false],
      [undefined, false],
      [42, false],
      [true, false],
      [{ catalog: true }, false],
    ])('isValidSystemSource(%j) === %s', (input, expected) => {
      expect(isValidSystemSource(input)).toBe(expected);
    });

    it('narrows type to SystemSource on success', () => {
      const value: unknown = 'catalog';
      if (isValidSystemSource(value)) {
        // TypeScript should narrow to SystemSource here
        const _source: SystemSource = value;
        expect(_source).toBe('catalog');
      }
    });
  });
});
