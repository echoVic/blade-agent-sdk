import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../__tests__/helpers/assertDefined.js';
import { SessionId } from '../../../../types/identifiers.js';
import { FileAccessTracker } from '../FileAccessTracker.js';

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
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      expect(tracker.hasFileBeenRead(testFile)).toBe(true);
    });

    it('should track file count', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      expect(tracker.getTrackedFileCount()).toBe(1);
    });

    it('keeps independent records for different sessions', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      await tracker.recordFileRead(testFile, SessionId('session-2'));

      expect(tracker.hasFileBeenRead(testFile, 'session-1')).toBe(true);
      expect(tracker.hasFileBeenRead(testFile, 'session-2')).toBe(true);
      expect(tracker.getTrackedFileCount()).toBe(2);
    });

    it('evicts the least recently recorded file at the configured bound', async () => {
      FileAccessTracker.resetInstance();
      tracker = FileAccessTracker.getInstance(undefined, 2);
      const second = join(tempDir, 'second.txt');
      const third = join(tempDir, 'third.txt');
      await writeFile(second, 'second');
      await writeFile(third, 'third');

      await tracker.recordFileRead(testFile, SessionId('session-1'));
      await tracker.recordFileRead(second, SessionId('session-1'));
      await tracker.recordFileRead(third, SessionId('session-1'));

      expect(tracker.hasFileBeenRead(testFile, 'session-1')).toBe(false);
      expect(tracker.getTrackedFileCount()).toBe(2);
    });
  });

  describe('hasFileBeenRead', () => {
    it('should return false for untracked file', () => {
      expect(tracker.hasFileBeenRead('/nonexistent')).toBe(false);
    });

    it('should return true for tracked file', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      expect(tracker.hasFileBeenRead(testFile)).toBe(true);
    });

    it('should respect sessionId filter', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      expect(tracker.hasFileBeenRead(testFile, 'session-1')).toBe(true);
      expect(tracker.hasFileBeenRead(testFile, 'session-2')).toBe(false);
    });
  });

  describe('recordFileEdit', () => {
    it('should record file edit', async () => {
      await tracker.recordFileEdit(testFile, SessionId('session-1'), 'edit');
      const record = tracker.getFileRecord(testFile);
      expect(record).toBeDefined();
      assertDefined(record);
      expect(record.lastOperation).toBe('edit');
    });

    it('should record file write', async () => {
      await tracker.recordFileEdit(testFile, SessionId('session-1'), 'write');
      const record = tracker.getFileRecord(testFile);
      assertDefined(record);
      expect(record.lastOperation).toBe('write');
    });
  });

  describe('getFileRecord', () => {
    it('should return undefined for untracked file', () => {
      expect(tracker.getFileRecord('/nonexistent')).toBeUndefined();
    });

    it('should return record with correct fields', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      const record = tracker.getFileRecord(testFile);
      expect(record).toBeDefined();
      assertDefined(record);
      expect(record.filePath).toBe(testFile);
      expect(record.sessionId).toBe('session-1');
      expect(record.lastOperation).toBe('read');
      expect(record.accessTime).toBeGreaterThan(0);
      expect(record.mtime).toBeGreaterThan(0);
    });
  });

  describe('clearFileRecord', () => {
    it('should clear specific file record', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      tracker.clearFileRecord(testFile);
      expect(tracker.hasFileBeenRead(testFile)).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should clear all records', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      tracker.clearAll();
      expect(tracker.getTrackedFileCount()).toBe(0);
    });
  });

  describe('clearSession', () => {
    it('should clear records for specific session', async () => {
      const testFile2 = join(tempDir, 'test2.txt');
      await writeFile(testFile2, 'hello');
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      await tracker.recordFileRead(testFile2, SessionId('session-2'));
      tracker.clearSession(SessionId('session-1'));
      expect(tracker.hasFileBeenRead(testFile)).toBe(false);
      expect(tracker.hasFileBeenRead(testFile2)).toBe(true);
    });
  });

  describe('getTrackedFiles', () => {
    it('should return all tracked file paths', async () => {
      const testFile2 = join(tempDir, 'test2.txt');
      await writeFile(testFile2, 'hello');
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      await tracker.recordFileRead(testFile2, SessionId('session-1'));
      const files = tracker.getTrackedFiles();
      expect(files).toContain(testFile);
      expect(files).toContain(testFile2);
    });
  });

  describe('checkFileModification', () => {
    it('should return not modified for freshly read file', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      const result = await tracker.checkFileModification(testFile);
      expect(result.modified).toBe(false);
    });

    it('should return message for untracked file', async () => {
      const result = await tracker.checkFileModification('/nonexistent');
      expect(result.modified).toBe(false);
      expect(result.message).toContain('未被跟踪');
    });

    it('detects a rapid replacement without a multi-second tolerance', async () => {
      await tracker.recordFileRead(testFile, SessionId('session-1'));
      await writeFile(testFile, 'changed content');

      const result = await tracker.checkExternalModification(
        testFile,
        SessionId('session-1'),
      );

      expect(result.isExternal).toBe(true);
    });
  });
});
