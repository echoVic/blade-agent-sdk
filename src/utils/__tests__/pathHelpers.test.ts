import { describe, expect, it } from 'bun:test';
import { endsWithSeparator, splitPath } from '../pathHelpers.js';

describe('pathHelpers', () => {
  describe('endsWithSeparator', () => {
    it('should return true for paths ending with forward slash', () => {
      expect(endsWithSeparator('/Users/john/')).toBe(true);
    });

    it('should return true for paths ending with backslash', () => {
      expect(endsWithSeparator('C:\\Users\\HP\\')).toBe(true);
    });

    it('should return false for paths not ending with a separator', () => {
      expect(endsWithSeparator('/Users/john')).toBe(false);
    });

    it('should return false for paths ending with a filename', () => {
      expect(endsWithSeparator('/Users/john/file.txt')).toBe(false);
    });

    it('should return false for an empty string', () => {
      expect(endsWithSeparator('')).toBe(false);
    });

    it('should return true for a single forward slash', () => {
      expect(endsWithSeparator('/')).toBe(true);
    });

    it('should return true for a single backslash', () => {
      expect(endsWithSeparator('\\')).toBe(true);
    });
  });

  describe('splitPath', () => {
    it('should split a Unix absolute path', () => {
      expect(splitPath('/Users/john/file.txt')).toEqual(['Users', 'john', 'file.txt']);
    });

    it('should split a Windows path', () => {
      expect(splitPath('C:\\Users\\HP\\file.txt')).toEqual(['C:', 'Users', 'HP', 'file.txt']);
    });

    it('should return an empty array for an empty string', () => {
      expect(splitPath('')).toEqual([]);
    });

    it('should handle root path', () => {
      expect(splitPath('/')).toEqual([]);
    });

    it('should handle paths with multiple consecutive separators', () => {
      expect(splitPath('/Users//john///file.txt')).toEqual(['Users', 'john', 'file.txt']);
    });

    it('should handle mixed separators', () => {
      expect(splitPath('/Users\\john/file.txt')).toEqual(['Users', 'john', 'file.txt']);
    });

    it('should handle a relative path', () => {
      expect(splitPath('src/utils/index.ts')).toEqual(['src', 'utils', 'index.ts']);
    });

    it('should handle a path with trailing separator', () => {
      expect(splitPath('/Users/john/')).toEqual(['Users', 'john']);
    });

    it('should handle a single filename', () => {
      expect(splitPath('file.txt')).toEqual(['file.txt']);
    });
  });
});
