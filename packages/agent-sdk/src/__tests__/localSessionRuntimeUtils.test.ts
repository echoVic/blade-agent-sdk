import { describe, expect, it } from 'vitest';
import { toJsonValue } from '../local/SessionRuntimeUtils.js';

describe('SessionRuntimeUtils', () => {
  describe('toJsonValue', () => {
    it('passes strings through unchanged', () => {
      expect(toJsonValue('hello')).toBe('hello');
      expect(toJsonValue('')).toBe('');
      expect(toJsonValue('{"key":"value"}')).toBe('{"key":"value"}');
    });

    it('serializes plain objects via JSON round-trip', () => {
      const obj = { key: 'value', num: 42, arr: [1, 2, 3] };
      const result = toJsonValue(obj);
      expect(result).toEqual({ key: 'value', num: 42, arr: [1, 2, 3] });
    });

    it('handles nested objects and arrays', () => {
      const nested = { outer: { inner: [1, 2, { deep: true }] }, list: ['a', 'b'] };
      const result = toJsonValue(nested);
      expect(result).toEqual(nested);
    });

    it('falls back to String() for unserializable values', () => {
      const obj: Record<string, unknown> = {};
      const circular: Record<string, unknown> = { self: obj };
      obj.self = circular;
      const result = toJsonValue(circular as object);
      expect(typeof result).toBe('string');
    });

    it('returns a string for a plain Date object', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      const result = toJsonValue(date);
      // Date serializes to ISO string via JSON.stringify
      expect(typeof result).toBe('string');
      expect(result).toBe('2024-01-01T00:00:00.000Z');
    });
  });
});
