import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonicalJson.js';

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJson({ second: 2, first: 1 })).toBe('{"first":1,"second":2}');
  });

  it('rejects a top-level undefined value instead of violating its string contract', () => {
    expect(() => canonicalJson(undefined)).toThrow(/JSON-serializable/);
  });
});
