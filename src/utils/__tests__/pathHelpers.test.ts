import { describe, expect, it } from 'vitest';
import { splitPath } from '../pathHelpers.js';

describe('pathHelpers', () => {
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
