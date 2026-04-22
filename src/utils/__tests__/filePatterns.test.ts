import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDE_DIRS,
  FileFilter,
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

  describe('default file pattern filtering', () => {
    it('should ignore *.log files', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('error.log')).toBe(true);
    });

    it('should ignore *.lock files', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('some.lock')).toBe(true);
    });

    it('should ignore package-lock.json', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('package-lock.json')).toBe(true);
    });

    it('should ignore .DS_Store', () => {
      const filter = new FileFilter({ useGitignore: false, useDefaults: true });
      expect(filter.shouldIgnore('.DS_Store')).toBe(true);
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

});
