import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
  FileFilter,
  getExcludePatterns,
} from '../filePatterns.js';

describe('filePatterns', () => {
  describe('DEFAULT_EXCLUDE_DIRS', () => {
    it('should include node_modules', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('node_modules');
    });

    it('should include .git', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('.git');
    });

    it('should include dist', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('dist');
    });

    it('should include build', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('build');
    });

    it('should include .next', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('.next');
    });

    it('should include coverage', () => {
      expect(DEFAULT_EXCLUDE_DIRS).toContain('coverage');
    });
  });

  describe('DEFAULT_EXCLUDE_FILE_PATTERNS', () => {
    it('should include *.log', () => {
      expect(DEFAULT_EXCLUDE_FILE_PATTERNS).toContain('*.log');
    });

    it('should include *.lock', () => {
      expect(DEFAULT_EXCLUDE_FILE_PATTERNS).toContain('*.lock');
    });

    it('should include package-lock.json', () => {
      expect(DEFAULT_EXCLUDE_FILE_PATTERNS).toContain('package-lock.json');
    });

    it('should include .DS_Store', () => {
      expect(DEFAULT_EXCLUDE_FILE_PATTERNS).toContain('.DS_Store');
    });
  });

  describe('FileFilter', () => {
    it('should ignore node_modules paths with defaults', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('node_modules/lodash/index.js')).toBe(true);
    });

    it('should ignore .git paths with defaults', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('.git/config')).toBe(true);
    });

    it('should not ignore normal source files', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('src/index.ts')).toBe(false);
    });

    it('should ignore log files with defaults', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('error.log')).toBe(true);
    });

    it('should ignore lock files with defaults', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('package-lock.json')).toBe(true);
    });

    describe('shouldIgnoreDirectory', () => {
      it('should ignore node_modules directory', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        expect(filter.shouldIgnoreDirectory('node_modules')).toBe(true);
      });

      it('should ignore .git directory', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        expect(filter.shouldIgnoreDirectory('.git')).toBe(true);
      });

      it('should not ignore src directory', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        expect(filter.shouldIgnoreDirectory('src')).toBe(false);
      });
    });

    describe('filter', () => {
      it('should filter out ignored paths', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        const paths = ['src/index.ts', 'node_modules/lodash/index.js', 'README.md', '.DS_Store'];
        const result = filter.filter(paths);
        expect(result).toContain('src/index.ts');
        expect(result).toContain('README.md');
        expect(result).not.toContain('node_modules/lodash/index.js');
        expect(result).not.toContain('.DS_Store');
      });
    });

    describe('custom patterns', () => {
      it('should ignore custom patterns', () => {
        const filter = new FileFilter({
          useGitignore: false,
          useDefaults: false,
          customPatterns: ['*.test.ts'],
        });
        expect(filter.shouldIgnore('foo.test.ts')).toBe(true);
        expect(filter.shouldIgnore('foo.ts')).toBe(false);
      });
    });

    describe('getIgnorePatterns', () => {
      it('should return patterns array', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        const patterns = filter.getIgnorePatterns();
        expect(patterns.length).toBeGreaterThan(0);
      });
    });

    describe('getNegatePatterns', () => {
      it('should return negate patterns array', () => {
        const filter = new FileFilter({ useGitignore: false, useDefaults: true });
        const patterns = filter.getNegatePatterns();
        expect(Array.isArray(patterns)).toBe(true);
      });
    });
  });

  describe('getExcludePatterns', () => {
    it('should return default patterns', () => {
      const patterns = getExcludePatterns();
      expect(patterns).toContain('node_modules');
      expect(patterns).toContain('.git');
      expect(patterns).toContain('*.log');
    });

    it('should merge custom patterns', () => {
      const patterns = getExcludePatterns(['*.custom']);
      expect(patterns).toContain('*.custom');
      expect(patterns).toContain('node_modules');
    });
  });
});
