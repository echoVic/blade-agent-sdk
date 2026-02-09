import { describe, expect, it } from 'bun:test';
import { generateDiffSnippet, generateDiffSnippetWithMatch } from '../diffUtils.js';

/**
 * Helper: extract parsed JSON from the <<<DIFF>>> wrapper
 */
function parseDiffResult(result: string) {
  const jsonMatch = result.match(/<<<DIFF>>>\n([\s\S]*?)\n<<<\/DIFF>>>/);
  if (!jsonMatch) throw new Error('No DIFF markers found');
  return JSON.parse(jsonMatch[1]) as { patch: string; startLine: number; matchLine: number };
}

describe('generateDiffSnippet', () => {
  it('should return null when contents are identical', () => {
    expect(generateDiffSnippet('hello', 'hello')).toBeNull();
  });

  it('should return null for identical multi-line content', () => {
    expect(generateDiffSnippet('a\nb\nc', 'a\nb\nc')).toBeNull();
  });

  it('should return null for both empty strings', () => {
    expect(generateDiffSnippet('', '')).toBeNull();
  });

  it('should generate diff with DIFF markers for a change', () => {
    const result = generateDiffSnippet('hello world', 'hello universe');
    expect(result).not.toBeNull();
    expect(result).toContain('<<<DIFF>>>');
    expect(result).toContain('<<</DIFF>>>');
  });

  it('should return valid JSON with patch, startLine, matchLine', () => {
    const result = generateDiffSnippet('line1\nline2\nline3', 'line1\nchanged\nline3')!;
    const parsed = parseDiffResult(result);
    expect(parsed).toHaveProperty('patch');
    expect(parsed).toHaveProperty('startLine');
    expect(parsed).toHaveProperty('matchLine');
    expect(typeof parsed.patch).toBe('string');
    expect(typeof parsed.startLine).toBe('number');
    expect(typeof parsed.matchLine).toBe('number');
  });

  it('should show removed and added lines in patch', () => {
    const result = generateDiffSnippet('line1\nold\nline3', 'line1\nnew\nline3')!;
    const parsed = parseDiffResult(result);
    expect(parsed.patch).toContain('-old');
    expect(parsed.patch).toContain('+new');
  });

  it('should handle adding new lines', () => {
    const result = generateDiffSnippet('a\nb', 'a\nb\nc')!;
    const parsed = parseDiffResult(result);
    expect(parsed.patch).toContain('+c');
  });

  it('should handle removing lines', () => {
    const result = generateDiffSnippet('a\nb\nc', 'a\nc')!;
    const parsed = parseDiffResult(result);
    expect(parsed.patch).toContain('-b');
  });

  it('should handle empty old content (new file)', () => {
    const result = generateDiffSnippet('', 'new content');
    expect(result).not.toBeNull();
  });

  it('should handle empty new content (file cleared)', () => {
    const result = generateDiffSnippet('old content', '');
    expect(result).not.toBeNull();
  });

  it('should ensure startLine >= 1', () => {
    const result = generateDiffSnippet('first', 'modified')!;
    const parsed = parseDiffResult(result);
    expect(parsed.startLine).toBeGreaterThanOrEqual(1);
  });

  it('should respect custom contextLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[10] = 'CHANGED';
    const newContent = newLines.join('\n');

    const r2 = parseDiffResult(generateDiffSnippet(oldContent, newContent, 2)!);
    const r8 = parseDiffResult(generateDiffSnippet(oldContent, newContent, 8)!);
    expect(r8.patch.length).toBeGreaterThan(r2.patch.length);
  });

  it('should use default contextLines of 4', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[15] = 'CHANGED';
    const newContent = newLines.join('\n');

    const def = parseDiffResult(generateDiffSnippet(oldContent, newContent)!);
    const exp = parseDiffResult(generateDiffSnippet(oldContent, newContent, 4)!);
    expect(def.patch).toBe(exp.patch);
  });

  it('should handle multi-line insertions', () => {
    const result = generateDiffSnippet('a\nb\nc', 'a\nb\nx\ny\nc')!;
    const parsed = parseDiffResult(result);
    expect(parsed.patch).toContain('+x');
    expect(parsed.patch).toContain('+y');
  });

  it('should handle complete content replacement', () => {
    const result = generateDiffSnippet('aaa\nbbb', 'xxx\nyyy');
    expect(result).not.toBeNull();
  });

  it('should identify matchLine from hunk header', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[4] = 'CHANGED';
    const newContent = newLines.join('\n');

    const parsed = parseDiffResult(generateDiffSnippet(oldContent, newContent, 2)!);
    expect(parsed.matchLine).toBeGreaterThanOrEqual(1);
    expect(parsed.matchLine).toBeLessThanOrEqual(10);
  });
});

describe('generateDiffSnippetWithMatch', () => {
  it('should return null when oldString not found in oldContent', () => {
    expect(
      generateDiffSnippetWithMatch('hello world', 'hello universe', 'missing', 'x')
    ).toBeNull();
  });

  it('should generate diff with DIFF markers', () => {
    const old = 'line1\nline2\nline3';
    const nw = 'line1\nchanged\nline3';
    const result = generateDiffSnippetWithMatch(old, nw, 'line2', 'changed');
    expect(result).not.toBeNull();
    expect(result).toContain('<<<DIFF>>>');
    expect(result).toContain('<<</DIFF>>>');
  });

  it('should return valid JSON with patch, startLine, matchLine', () => {
    const old = 'aaa\nbbb\nccc\nddd\neee';
    const nw = 'aaa\nbbb\nxxx\nddd\neee';
    const result = generateDiffSnippetWithMatch(old, nw, 'ccc', 'xxx')!;
    const parsed = parseDiffResult(result);
    expect(parsed).toHaveProperty('patch');
    expect(parsed).toHaveProperty('startLine');
    expect(parsed).toHaveProperty('matchLine');
  });

  it('should calculate correct matchLine from oldString position', () => {
    const old = 'line1\nline2\nline3\nTARGET\nline5';
    const nw = 'line1\nline2\nline3\nREPLACED\nline5';
    const parsed = parseDiffResult(
      generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED')!
    );
    // TARGET starts at index after "line1\nline2\nline3\n"
    // beforeLines splits to ['line1','line2','line3',''], length=4, matchLine=4-1+1=4
    expect(parsed.matchLine).toBe(4);
  });

  it('should handle replacement at beginning of file', () => {
    const old = 'TARGET\nline2\nline3';
    const nw = 'REPLACED\nline2\nline3';
    const parsed = parseDiffResult(
      generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED')!
    );
    expect(parsed.startLine).toBeGreaterThanOrEqual(1);
    // beforeLines = [''], length=1, matchLine=1-1+1=1 => but code does length-1 => 0+1=1?
    // Actually: matchLine = beforeLines.length - 1 = 0, then startLine = max(0, 0-4)+1=1
    // matchLine in output = matchLine + 1 = 0 + 1 = 1
    expect(parsed.matchLine).toBe(1);
  });

  it('should handle replacement at end of file', () => {
    const old = 'line1\nline2\nTARGET';
    const nw = 'line1\nline2\nREPLACED';
    const result = generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED');
    expect(result).not.toBeNull();
  });

  it('should handle multi-line oldString', () => {
    const old = 'a\nb\nc\nd\ne';
    const nw = 'a\nx\ny\nz\ne';
    const result = generateDiffSnippetWithMatch(old, nw, 'b\nc\nd', 'x\ny\nz');
    expect(result).not.toBeNull();
  });

  it('should use first occurrence when oldString appears multiple times', () => {
    const old = 'dup\nother\ndup\nmore';
    const nw = 'REPLACED\nother\ndup\nmore';
    const parsed = parseDiffResult(
      generateDiffSnippetWithMatch(old, nw, 'dup', 'REPLACED')!
    );
    expect(parsed.matchLine).toBe(1);
  });

  it('should handle replacement that increases line count', () => {
    const old = 'a\nb\nc';
    const nw = 'a\nx1\nx2\nx3\nc';
    const result = generateDiffSnippetWithMatch(old, nw, 'b', 'x1\nx2\nx3');
    expect(result).not.toBeNull();
  });

  it('should handle replacement that decreases line count', () => {
    const old = 'a\nb\nc\nd\ne';
    const nw = 'a\nX\ne';
    const result = generateDiffSnippetWithMatch(old, nw, 'b\nc\nd', 'X');
    expect(result).not.toBeNull();
  });

  it('should respect custom contextLines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join('\n');
    const newLines = [...lines];
    newLines[15] = 'modified';
    const newContent = newLines.join('\n');

    const r2 = parseDiffResult(
      generateDiffSnippetWithMatch(oldContent, newContent, 'line16', 'modified', 2)!
    );
    const r8 = parseDiffResult(
      generateDiffSnippetWithMatch(oldContent, newContent, 'line16', 'modified', 8)!
    );
    expect(r8.patch.length).toBeGreaterThan(r2.patch.length);
  });

  it('should clamp startLine to at least 1', () => {
    const old = 'TARGET\nline2';
    const nw = 'REPLACED\nline2';
    const parsed = parseDiffResult(
      generateDiffSnippetWithMatch(old, nw, 'TARGET', 'REPLACED', 0)!
    );
    expect(parsed.startLine).toBeGreaterThanOrEqual(1);
  });
});
