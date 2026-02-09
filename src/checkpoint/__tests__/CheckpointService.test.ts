import { describe, expect, it, beforeEach } from 'bun:test';
import { CheckpointService, getCheckpointService } from '../CheckpointService.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CheckpointService', () => {
  let service: CheckpointService;
  let tempDir: string;

  beforeEach(() => {
    CheckpointService.resetInstance();
    service = CheckpointService.getInstance();
    tempDir = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = CheckpointService.getInstance();
      const b = CheckpointService.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = CheckpointService.getInstance();
      CheckpointService.resetInstance();
      const b = CheckpointService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('getCheckpointService', () => {
    it('should return the singleton', () => {
      expect(getCheckpointService()).toBe(CheckpointService.getInstance());
    });
  });

  describe('configure', () => {
    it('should enable checkpointing', () => {
      service.configure({ enabled: true });
      expect(service.isEnabled()).toBe(true);
    });

    it('should disable checkpointing', () => {
      service.configure({ enabled: true });
      service.configure({ enabled: false });
      expect(service.isEnabled()).toBe(false);
    });

    it('should clear state when disabled', () => {
      service.configure({ enabled: true });
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'hello');
      service.trackFileChange(file, 'create');
      service.createCheckpoint('msg-1', 'user');
      service.configure({ enabled: false });
      expect(service.getStatistics().checkpointCount).toBe(0);
    });
  });

  describe('isEnabled', () => {
    it('should return false by default', () => {
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('trackFileChange', () => {
    it('should not track when disabled', () => {
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'hello');
      service.trackFileChange(file, 'create');
      expect(service.getStatistics().pendingChangeCount).toBe(0);
    });

    it('should track when enabled', () => {
      service.configure({ enabled: true });
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'hello');
      service.trackFileChange(file, 'create');
      expect(service.getStatistics().pendingChangeCount).toBe(1);
    });

    it('should exclude files matching exclude patterns', () => {
      service.configure({ enabled: true, excludePatterns: ['*.log'] });
      const file = join(tempDir, 'app.log');
      writeFileSync(file, 'log data');
      service.trackFileChange(file, 'create');
      expect(service.getStatistics().pendingChangeCount).toBe(0);
    });
  });

  describe('createCheckpoint', () => {
    it('should not create when disabled', () => {
      service.createCheckpoint('msg-1', 'user');
      expect(service.getStatistics().checkpointCount).toBe(0);
    });

    it('should create checkpoint and clear pending changes', () => {
      service.configure({ enabled: true });
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'hello');
      service.trackFileChange(file, 'create');
      service.createCheckpoint('msg-1', 'user');
      expect(service.getStatistics().checkpointCount).toBe(1);
      expect(service.getStatistics().pendingChangeCount).toBe(0);
    });

    it('should enforce maxCheckpoints', () => {
      service.configure({ enabled: true, maxCheckpoints: 2 });
      service.createCheckpoint('msg-1', 'user');
      service.createCheckpoint('msg-2', 'assistant');
      service.createCheckpoint('msg-3', 'user');
      expect(service.getStatistics().checkpointCount).toBe(2);
    });
  });

  describe('getCheckpoint', () => {
    it('should return undefined for non-existent checkpoint', () => {
      expect(service.getCheckpoint('nonexistent')).toBeUndefined();
    });

    it('should return checkpoint by uuid', () => {
      service.configure({ enabled: true });
      service.createCheckpoint('msg-1', 'user');
      const cp = service.getCheckpoint('msg-1');
      expect(cp).toBeDefined();
      expect(cp!.messageUuid).toBe('msg-1');
      expect(cp!.messageRole).toBe('user');
    });
  });

  describe('getAllCheckpoints', () => {
    it('should return all checkpoints in order', () => {
      service.configure({ enabled: true });
      service.createCheckpoint('msg-1', 'user');
      service.createCheckpoint('msg-2', 'assistant');
      const all = service.getAllCheckpoints();
      expect(all).toHaveLength(2);
      expect(all[0].messageUuid).toBe('msg-1');
      expect(all[1].messageUuid).toBe('msg-2');
    });
  });

  describe('rewindFiles', () => {
    it('should fail when disabled', async () => {
      const result = await service.rewindFiles('msg-1');
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should fail for non-existent checkpoint', async () => {
      service.configure({ enabled: true });
      const result = await service.rewindFiles('nonexistent');
      expect(result.success).toBe(false);
    });

    it('should restore modified file to checkpoint state', async () => {
      service.configure({ enabled: true });
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'original');

      // Capture initial state
      service.captureBeforeWrite(file);
      service.createCheckpoint('msg-1', 'user');

      // Modify file
      writeFileSync(file, 'modified');
      service.trackFileChange(file, 'modify');
      service.createCheckpoint('msg-2', 'assistant');

      // Rewind to msg-1
      const result = await service.rewindFiles('msg-1');
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('original');
    });

    it('should delete file created after checkpoint', async () => {
      service.configure({ enabled: true });

      // Create initial checkpoint (no files tracked yet)
      service.createCheckpoint('msg-1', 'user');

      // Create a new file and capture before-write (file doesn't exist yet)
      const file = join(tempDir, 'new-file.txt');
      service.captureBeforeWrite(file); // captures snapshot with exists=false
      writeFileSync(file, 'new content');
      service.trackFileChange(file, 'create');
      service.createCheckpoint('msg-2', 'assistant');

      // Rewind to msg-1 should delete the file
      const result = await service.rewindFiles('msg-1');
      expect(result.deletedFiles).toContain(file);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('getChangedFilesSince', () => {
    it('should return empty for non-existent checkpoint', () => {
      expect(service.getChangedFilesSince('nonexistent')).toEqual([]);
    });

    it('should return changed files since checkpoint', () => {
      service.configure({ enabled: true });
      service.createCheckpoint('msg-1', 'user');

      const file = join(tempDir, 'changed.txt');
      writeFileSync(file, 'data');
      service.trackFileChange(file, 'create');
      service.createCheckpoint('msg-2', 'assistant');

      const changed = service.getChangedFilesSince('msg-1');
      expect(changed).toContain(file);
    });
  });

  describe('getStatistics', () => {
    it('should return zero stats initially', () => {
      const stats = service.getStatistics();
      expect(stats.checkpointCount).toBe(0);
      expect(stats.trackedFileCount).toBe(0);
      expect(stats.pendingChangeCount).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all state', () => {
      service.configure({ enabled: true });
      const file = join(tempDir, 'test.txt');
      writeFileSync(file, 'hello');
      service.trackFileChange(file, 'create');
      service.createCheckpoint('msg-1', 'user');
      service.clear();
      const stats = service.getStatistics();
      expect(stats.checkpointCount).toBe(0);
      expect(stats.trackedFileCount).toBe(0);
      expect(stats.pendingChangeCount).toBe(0);
    });
  });
});
