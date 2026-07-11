import { describe, expect, it } from 'vitest';
import {
  generateDiffSnippet,
  generateDiffSnippetWithMatch,
} from '../local/file/diffUtils.js';

function expectDiffResult(result: string | null): string {
  expect(result).not.toBeNull();
  if (result === null) throw new Error('Expected diff result');
  return result;
}

function parseDiffResult(result: string | null) {
  const diffResult = expectDiffResult(result);
  const jsonMatch = diffResult.match(/<<<DIFF>>>\n([\s\S]*?)\n<<<\/DIFF>>>/);
  if (!jsonMatch) throw new Error('No DIFF markers found');
  return JSON.parse(jsonMatch[1]) as {
    patch: string;
    startLine: number;
    matchLine: number;
  };
}

describe('package-local diffUtils', () => {
  describe('generateDiffSnippet', () => {
    it('returns null when contents are identical', () => {
      expect(generateDiffSnippet('hello', 'hello')).toBeNull();
    });

    it('returns null for identical multi-line content', () => {
      expect(generateDiffSnippet('a\nb\nc', 'a\nb\nc')).toBeNull();
    });

    it('returns null for both empty strings', () => {
      expect(generateDiffSnippet('', '')).toBeNull();
    });

    it('generates diff with DIFF markers for a change', () => {
      const result = generateDiffSnippet('hello world', 'hello universe');
      expect(result).not.toBeNull();
      expect(result).toContain('<<<DIFF>>>');
      expect(result).toContain('<<</DIFF>>>');
    });

    it('returns valid JSON with patch, startLine, matchLine', () => {
      const result = generateDiffSnippet('line1\nline2\nline3', 'line1\nchanged\nline3');
      const parsed = parseDiffResult(result);
      expect(parsed).toHaveProperty('patch');
      expect(parsed).toHaveProperty('startLine');
      expect(parsed).toHaveProperty('matchLine');
      expect(typeof parsed.patch).toBe('string');
      expect(typeof parsed.startLine).toBe('number');
      expect(typeof parsed.matchLine).toBe('number');
    });

    it('shows removed and added lines in patch', () => {
      const result = generateDiffSnippet('line1\nold\nline3', 'line1\nnew\nline3');
      const parsed = parseDiffResult(result);
      expect(parsed.patch).toContain('-old');
      expect(parsed.patch).toContain('+new');
    });

    it('handles empty old content (new file)', () => {
      const result = generateDiffSnippet('', 'new content');
      expect(result).not.toBeNull();
    });

    it('handles empty new content (file cleared)', () => {
      const result = generateDiffSnippet('old content', '');
      expect(result).not.toBeNull();
    });

    it('ensures startLine >= 1', () => {
      const result = generateDiffSnippet('first', 'modified');
      const parsed = parseDiffResult(result);
      expect(parsed.startLine).toBeGreaterThanOrEqual(1);
    });
  });

  describe('generateDiffSnippetWithMatch', () => {
    it('returns null when oldString is not found', () => {
      expect(
        generateDiffSnippetWithMatch('hello', 'world', 'missing', 'x'),
      ).toBeNull();
    });

    it('generates diff with DIFF markers', () => {
      const old = 'line1\nline2\nline3';
      const nw = 'line1\nchanged\nline3';
      const result = generateDiffSnippetWithMatch(old, nw, 'line2', 'changed');
      expect(result).not.toBeNull();
      expect(result).toContain('<<<DIFF>>>');
      expect(result).toContain('<<</DIFF>>>');
    });

    it('calculates correct matchLine from oldString position', () => {
      const old = 'line1\nline2\nline3\nTARGET\nline5';
      const nw = 'line1\nline2\nline3\nREPLACED\nline5';
      const parsed = parseDiffResult(
        generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED'),
      );
      expect(parsed.matchLine).toBe(4);
    });

    it('handles replacement at beginning of file', () => {
      const old = 'TARGET\nline2\nline3';
      const nw = 'REPLACED\nline2\nline3';
      const parsed = parseDiffResult(
        generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED'),
      );
      expect(parsed.matchLine).toBe(1);
    });

    it('handles multi-line oldString', () => {
      const old = 'a\nb\nc\nd\ne';
      const nw = 'a\nx\ny\nz\ne';
      const result = generateDiffSnippetWithMatch(old, nw, 'b\nc\nd', 'x\ny\nz');
      expect(result).not.toBeNull();
    });

    it('uses first occurrence when oldString appears multiple times', () => {
      const old = 'dup\nother\ndup\nmore';
      const nw = 'REPLACED\nother\ndup\nmore';
      const parsed = parseDiffResult(
        generateDiffSnippetWithMatch(old, nw, 'dup', 'REPLACED'),
      );
      expect(parsed.matchLine).toBe(1);
    });

    it('clamps startLine to at least 1', () => {
      const old = 'TARGET\nline2';
      const nw = 'REPLACED\nline2';
      const parsed = parseDiffResult(
        generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED', 0),
      );
      expect(parsed.startLine).toBeGreaterThanOrEqual(1);
    });
  });
});
