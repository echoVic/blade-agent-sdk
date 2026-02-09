import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import {
  unescapeProjectPath,
  getProjectStoragePath,
  getSessionFilePath,
  getBladeStorageRoot,
} from '../pathUtils.js';

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
    it('should return path under ~/.blade/projects/', () => {
      const result = getProjectStoragePath('/Users/john/project');
      expect(result).toContain('.blade');
      expect(result).toContain('projects');
    });

    it('should return consistent path for same input', () => {
      const result1 = getProjectStoragePath('/Users/john/project');
      const result2 = getProjectStoragePath('/Users/john/project');
      expect(result1).toBe(result2);
    });
  });

  describe('getSessionFilePath', () => {
    it('should return .jsonl file path', () => {
      const result = getSessionFilePath('/Users/john/project', 'session-123');
      expect(result).toContain('session-123.jsonl');
    });

    it('should be under project storage path', () => {
      const projectPath = '/Users/john/project';
      const storagePath = getProjectStoragePath(projectPath);
      const sessionPath = getSessionFilePath(projectPath, 'session-123');
      expect(sessionPath.startsWith(storagePath)).toBe(true);
    });
  });

  describe('getBladeStorageRoot', () => {
    it('should return path ending with .blade', () => {
      const result = getBladeStorageRoot();
      expect(result).toContain('.blade');
    });

    it('should return consistent path', () => {
      expect(getBladeStorageRoot()).toBe(getBladeStorageRoot());
    });
  });
});
