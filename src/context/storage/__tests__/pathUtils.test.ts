import { describe, expect, it } from 'bun:test';
import {
  unescapeProjectPath,
  getProjectStoragePath,
  getSessionFilePath,
} from '../pathUtils.js';

const STORAGE_ROOT = '/tmp/test-storage';

describe('pathUtils', () => {
  describe('unescapeProjectPath', () => {
    it('should unescape Unix-style path', () => {
      const result = unescapeProjectPath('-Users-john-projects-my-app');
      expect(result).toBe('/Users/john/projects/my/app');
    });

    it('should unescape Windows-style path', () => {
      const result = unescapeProjectPath('C_-Users-HP-project');
      expect(result).toBe('C:/Users/HP/project');
    });

    it('should handle path without leading dash', () => {
      const result = unescapeProjectPath('relative-path');
      expect(result).toBe('relative/path');
    });
  });

  describe('getProjectStoragePath', () => {
    it('should return path under storageRoot/projects/', () => {
      const result = getProjectStoragePath(STORAGE_ROOT, '/Users/john/project');
      expect(result).toContain('projects');
      expect(result.startsWith(STORAGE_ROOT)).toBe(true);
    });

    it('should return consistent path for same input', () => {
      const result1 = getProjectStoragePath(STORAGE_ROOT, '/Users/john/project');
      const result2 = getProjectStoragePath(STORAGE_ROOT, '/Users/john/project');
      expect(result1).toBe(result2);
    });
  });

  describe('getSessionFilePath', () => {
    it('should return .jsonl file path', () => {
      const result = getSessionFilePath(STORAGE_ROOT, '/Users/john/project', 'session-123');
      expect(result).toContain('session-123.jsonl');
    });

    it('should be under project storage path', () => {
      const projectPath = '/Users/john/project';
      const storagePath = getProjectStoragePath(STORAGE_ROOT, projectPath);
      const sessionPath = getSessionFilePath(STORAGE_ROOT, projectPath, 'session-123');
      expect(sessionPath.startsWith(storagePath)).toBe(true);
    });
  });
});
