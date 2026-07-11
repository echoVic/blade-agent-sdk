import { describe, expect, it } from 'vitest';
import { splitPath } from '../utils/splitPath.js';

describe('package-local splitPath', () => {
  it('splits a POSIX path into parts', () => {
    expect(splitPath('/a/b/c.txt')).toEqual(['a', 'b', 'c.txt']);
  });

  it('splits a Windows path with backslashes', () => {
    expect(splitPath('C:\\Users\\HP\\file.txt')).toEqual(['C:', 'Users', 'HP', 'file.txt']);
  });

  it('splits a mixed-separator path', () => {
    expect(splitPath('a\\b/c\\d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('strips leading and trailing separators', () => {
    expect(splitPath('/leading/trailing/')).toEqual(['leading', 'trailing']);
  });

  it('handles relative path without leading separator', () => {
    expect(splitPath('relative/path/to/file.ts')).toEqual(['relative', 'path', 'to', 'file.ts']);
  });

  it('returns an empty array for a root path', () => {
    expect(splitPath('/')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitPath('')).toEqual([]);
  });

  it('returns an empty array for a string of only separators', () => {
    expect(splitPath('///\\\\///')).toEqual([]);
  });

  it('handles single-component path', () => {
    expect(splitPath('file.txt')).toEqual(['file.txt']);
  });

  it('handles path with repeated separators', () => {
    expect(splitPath('a//b///c')).toEqual(['a', 'b', 'c']);
  });
});
