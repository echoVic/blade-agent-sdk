import { describe, expect, it, beforeEach } from 'bun:test';
import { FileAccessTracker } from '../FileAccessTracker.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FileAccessTracker', () => {
  let tracker: FileAccessTracker;
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    FileAccessTracker.resetInstance();
    tracker = FileAccessTracker.getInstance();
    tempDir = await mkdtemp(join(tmpdir(), 'file-tracker-test-'));
    testFile = join(tempDir, 'test.txt');
    await writeFile(testFile, 'hello world');
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = FileAccessTracker.getInstance();
      const b = FileAccessTracker.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = FileAccessTracker.getInstance();
      FileAccessTracker.resetInstance();
      const b = FileAccessTracker.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('recordFileRead', () => {
    it('should record file read', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      expect(tracker.hasFileBeenRead(testFile)).toBe(true);
    });

    it('should track file count', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      expect(tracker.getTrackedFileCount()).toBe(1);
    });
  });

  describe('hasFileBeenRead', () => {
    it('should return false for untracked file', () => {
      expect(tracker.hasFileBeenRead('/nonexistent')).toBe(false);
    });

    it('should return true for tracked file', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      expect(tracker.hasFileBeenRead(testFile)).toBe(true);
    });

    it('should respect sessionId filter', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      expect(tracker.hasFileBeenRead(testFile, 'session-1')).toBe(true);
      expect(tracker.hasFileBeenRead(testFile, 'session-2')).toBe(false);
    });
  });

  describe('recordFileEdit', () => {
    it('should record file edit', async () => {
      await tracker.recordFileEdit(testFile, 'session-1', 'edit');
      const record = tracker.getFileRecord(testFile);
      expect(record).toBeDefined();
      expect(record!.lastOperation).toBe('edit');
    });

    it('should record file write', async () => {
      await tracker.recordFileEdit(testFile, 'session-1', 'write');
      const record = tracker.getFileRecord(testFile);
      expect(record!.lastOperation).toBe('write');
    });
  });

  describe('getFileRecord', () => {
    it('should return undefined for untracked file', () => {
      expect(tracker.getFileRecord('/nonexistent')).toBeUndefined();
    });

    it('should return record with correct fields', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      const record = tracker.getFileRecord(testFile);
      expect(record).toBeDefined();
      expect(record!.filePath).toBe(testFile);
      expect(record!.sessionId).toBe('session-1');
      expect(record!.lastOperation).toBe('read');
      expect(record!.accessTime).toBeGreaterThan(0);
      expect(record!.mtime).toBeGreaterThan(0);
    });
  });

  describe('clearFileRecord', () => {
    it('should clear specific file record', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      tracker.clearFileRecord(testFile);
      expect(tracker.hasFileBeenRead(testFile)).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should clear all records', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      tracker.clearAll();
      expect(tracker.getTrackedFileCount()).toBe(0);
    });
  });

  describe('clearSession', () => {
    it('should clear records for specific session', async () => {
      const testFile2 = join(tempDir, 'test2.txt');
      await writeFile(testFile2, 'hello');
      await tracker.recordFileRead(testFile, 'session-1');
      await tracker.recordFileRead(testFile2, 'session-2');
      tracker.clearSession('session-1');
      expect(tracker.hasFileBeenRead(testFile)).toBe(false);
      expect(tracker.hasFileBeenRead(testFile2)).toBe(true);
    });
  });

  describe('getTrackedFiles', () => {
    it('should return all tracked file paths', async () => {
      const testFile2 = join(tempDir, 'test2.txt');
      await writeFile(testFile2, 'hello');
      await tracker.recordFileRead(testFile, 'session-1');
      await tracker.recordFileRead(testFile2, 'session-1');
      const files = tracker.getTrackedFiles();
      expect(files).toContain(testFile);
      expect(files).toContain(testFile2);
    });
  });

  describe('checkFileModification', () => {
    it('should return not modified for freshly read file', async () => {
      await tracker.recordFileRead(testFile, 'session-1');
      const result = await tracker.checkFileModification(testFile);
      expect(result.modified).toBe(false);
    });

    it('should return message for untracked file', async () => {
      const result = await tracker.checkFileModification('/nonexistent');
      expect(result.modified).toBe(false);
      expect(result.message).toContain('未被跟踪');
    });
  });
});
