import { describe, expect, it } from 'vitest';
import { getString, matchesMcpServer, sanitizeSegment, toJsonValue } from '../local/SessionRuntimeUtils.js';
import type { Tool } from '../tools/types/index.js';

describe('SessionRuntimeUtils', () => {
  describe('getString', () => {
    it('returns a matching string value', () => {
      expect(getString({ key: 'hello' }, 'key')).toBe('hello');
    });

    it('returns the default when key is missing', () => {
      expect(getString({}, 'key')).toBe('');
    });

    it('returns the default for non-string values', () => {
      expect(getString({ key: 42 }, 'key')).toBe('');
      expect(getString({ key: true }, 'key')).toBe('');
      expect(getString({ key: null }, 'key')).toBe('');
    });

    it('uses a custom default value', () => {
      expect(getString({}, 'key', 'fallback')).toBe('fallback');
      expect(getString({ key: 42 }, 'key', 'fallback')).toBe('fallback');
    });

    it('returns empty string for missing keys', () => {
      expect(getString({ present: 'hello' }, 'absent')).toBe('');
    });
  });

  describe('matchesMcpServer', () => {
    const makeTool = (name: string, tags: string[]): Tool =>
      ({ name, tags } as unknown as Tool);

    it('matches by tag', () => {
      const tool = makeTool('my_tool', ['github', 'other']);
      expect(matchesMcpServer(tool, 'github')).toBe(true);
    });

    it('matches by legacy name prefix', () => {
      const tool = makeTool('mcp__github__list_repos', []);
      expect(matchesMcpServer(tool, 'github')).toBe(true);
    });

    it('returns false for non-matching server', () => {
      const tool = makeTool('my_tool', ['gitlab']);
      expect(matchesMcpServer(tool, 'github')).toBe(false);
    });

    it('returns false for tool with no tags and standard name', () => {
      const tool = makeTool('standard_tool', []);
      expect(matchesMcpServer(tool, 'github')).toBe(false);
    });
  });

  describe('sanitizeSegment', () => {
    it('preserves alphanumeric chars, dots, hyphens, and underscores', () => {
      expect(sanitizeSegment('hello-world_123.test')).toBe('hello-world_123.test');
    });

    it('replaces spaces and special chars with hyphens', () => {
      expect(sanitizeSegment('hello world!')).toBe('hello-world-');
    });

    it('truncates strings longer than 64 characters', () => {
      const input = 'a'.repeat(100);
      expect(sanitizeSegment(input)).toBe('a'.repeat(64));
    });

    it('falls back to "artifact" for empty string input', () => {
      expect(sanitizeSegment('')).toBe('artifact');
    });

    it('handles session IDs and tool names', () => {
      expect(sanitizeSegment('session_abc-123')).toBe('session_abc-123');
      expect(sanitizeSegment('read@file/v1')).toBe('read-file-v1');
    });
  });

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
