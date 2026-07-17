import { describe, expect, it } from 'vitest';
import {
  AtMentionParser,
  extract,
  hasAtMentions,
  isValidPath,
  removeAtMentions,
} from '../local/index.js';

describe('extract', () => {
  it('extracts bare path mentions', () => {
    const mentions = extract('Read @src/agent.ts carefully');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].path).toBe('src/agent.ts');
    expect(mentions[0].raw).toBe('@src/agent.ts');
    expect(mentions[0].lineRange).toBeUndefined();
  });

  it('extracts quoted path mentions with spaces', () => {
    const mentions = extract('Check @"docs/User Guide.pdf"');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].path).toBe('docs/User Guide.pdf');
  });

  it('extracts mentions with line range', () => {
    const mentions = extract('Look at @src/app.ts#L10-20');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].path).toBe('src/app.ts');
    expect(mentions[0].lineRange).toEqual({ start: 10, end: 20 });
  });

  it('extracts mentions with single line', () => {
    const mentions = extract('Check @lib/util.ts#L5');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].path).toBe('lib/util.ts');
    expect(mentions[0].lineRange).toEqual({ start: 5 });
  });

  it('detects glob patterns', () => {
    const mentions = extract('Match @src/*.ts');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].isGlob).toBe(true);
  });

  it('detects glob patterns with ? wildcard', () => {
    const mentions = extract('Check @src/test?.ts');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].isGlob).toBe(true);
  });

  it('returns empty array for no mentions', () => {
    expect(extract('No mentions here')).toEqual([]);
  });

  it('handles multiple mentions', () => {
    const result = extract('Read @a.ts and @b.ts');
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('a.ts');
    expect(result[1].path).toBe('b.ts');
  });

  it('records correct start and end indices', () => {
    const result = extract('Read @test.ts here');
    expect(result).toHaveLength(1);
    expect(result[0].startIndex).toBe(5);
    expect(result[0].endIndex).toBe(13);
  });
});

describe('hasAtMentions', () => {
  it('returns true when @ is present', () => {
    expect(hasAtMentions('Read @file.ts')).toBe(true);
  });

  it('returns false when no @ is present', () => {
    expect(hasAtMentions('No mentions here')).toBe(false);
  });
});

describe('isValidPath', () => {
  it('accepts normal paths', () => {
    expect(isValidPath('src/index.ts')).toBe(true);
  });

  it('rejects empty path', () => {
    expect(isValidPath('')).toBe(false);
  });

  it('rejects paths with invalid characters', () => {
    expect(isValidPath('bad<path.ts')).toBe(false);
    expect(isValidPath('bad|path.ts')).toBe(false);
  });
});

describe('removeAtMentions', () => {
  it('removes all @ mentions from string', () => {
    expect(removeAtMentions('Read @a.ts and @b.ts')).toBe('Read  and ');
  });

  it('returns string unchanged when no mentions', () => {
    expect(removeAtMentions('No mentions')).toBe('No mentions');
  });
});

describe('AtMentionParser namespace', () => {
  it('provides all functions as methods', () => {
    expect(typeof AtMentionParser.extract).toBe('function');
    expect(typeof AtMentionParser.hasAtMentions).toBe('function');
    expect(typeof AtMentionParser.isValidPath).toBe('function');
    expect(typeof AtMentionParser.removeAtMentions).toBe('function');
  });
});
