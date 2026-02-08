/**
 * File Checkpointing Service
 *
 * Tracks file changes during a session and enables rewinding files
 * to their state at any previous user message.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  CheckpointConfig,
  FileChange,
  FileSnapshot,
  MessageCheckpoint,
  RewindError,
  RewindResult,
} from './types.js';

const logger = createLogger(LogCategory.TOOL);

export class CheckpointService {
  private static instance: CheckpointService | null = null;
  private config: CheckpointConfig = { enabled: false };
  private checkpoints: Map<string, MessageCheckpoint> = new Map();
  private checkpointOrder: string[] = [];
  private currentFileSnapshots: Map<string, FileSnapshot> = new Map();
  private pendingChanges: FileChange[] = [];

  private constructor() {}

  static getInstance(): CheckpointService {
    if (!CheckpointService.instance) {
      CheckpointService.instance = new CheckpointService();
    }
    return CheckpointService.instance;
  }

  static resetInstance(): void {
    CheckpointService.instance = null;
  }

  configure(config: Partial<CheckpointConfig>): void {
    this.config = { ...this.config, ...config };
    if (!this.config.enabled) {
      this.clear();
    }
    logger.debug(`[CheckpointService] Configured: enabled=${this.config.enabled}`);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  clear(): void {
    this.checkpoints.clear();
    this.checkpointOrder = [];
    this.currentFileSnapshots.clear();
    this.pendingChanges = [];
    logger.debug('[CheckpointService] Cleared all checkpoints');
  }

  private shouldExclude(filePath: string): boolean {
    if (!this.config.excludePatterns || this.config.excludePatterns.length === 0) {
      return false;
    }

    return this.config.excludePatterns.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(filePath);
      }
      return filePath.includes(pattern);
    });
  }

  private captureSnapshot(filePath: string): FileSnapshot {
    const exists = existsSync(filePath);
    let content: string | null = null;

    if (exists) {
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        content = null;
      }
    }

    return {
      filePath,
      content,
      exists,
      timestamp: new Date(),
    };
  }

  trackFileChange(filePath: string, operation: 'create' | 'modify' | 'delete'): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.shouldExclude(filePath)) {
      logger.debug(`[CheckpointService] Excluded file: ${filePath}`);
      return;
    }

    const beforeSnapshot = this.currentFileSnapshots.get(filePath) || null;
    const afterSnapshot = this.captureSnapshot(filePath);

    const change: FileChange = {
      filePath,
      operation,
      beforeSnapshot,
      afterSnapshot,
      timestamp: new Date(),
    };

    this.pendingChanges.push(change);
    this.currentFileSnapshots.set(filePath, afterSnapshot);

    logger.debug(`[CheckpointService] Tracked ${operation}: ${filePath}`);
  }

  captureBeforeWrite(filePath: string): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.shouldExclude(filePath)) {
      return;
    }

    if (!this.currentFileSnapshots.has(filePath)) {
      const snapshot = this.captureSnapshot(filePath);
      this.currentFileSnapshots.set(filePath, snapshot);
      logger.debug(`[CheckpointService] Captured before-write snapshot: ${filePath}`);
    }
  }

  createCheckpoint(messageUuid: string, messageRole: 'user' | 'assistant'): void {
    if (!this.config.enabled) {
      return;
    }

    const checkpoint: MessageCheckpoint = {
      messageUuid,
      messageRole,
      timestamp: new Date(),
      fileChanges: [...this.pendingChanges],
      fileSnapshots: new Map(this.currentFileSnapshots),
    };

    this.checkpoints.set(messageUuid, checkpoint);
    this.checkpointOrder.push(messageUuid);
    this.pendingChanges = [];

    if (this.config.maxCheckpoints && this.checkpointOrder.length > this.config.maxCheckpoints) {
      const oldestUuid = this.checkpointOrder.shift();
      if (oldestUuid) {
        this.checkpoints.delete(oldestUuid);
      }
    }

    logger.debug(`[CheckpointService] Created checkpoint: ${messageUuid} (${messageRole})`);
  }

  getCheckpoint(messageUuid: string): MessageCheckpoint | undefined {
    return this.checkpoints.get(messageUuid);
  }

  getAllCheckpoints(): MessageCheckpoint[] {
    return this.checkpointOrder.map((uuid) => this.checkpoints.get(uuid)!).filter(Boolean);
  }

  async rewindFiles(targetMessageUuid: string): Promise<RewindResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        restoredFiles: [],
        deletedFiles: [],
        errors: [{ filePath: '', error: 'File checkpointing is not enabled' }],
      };
    }

    const targetCheckpoint = this.checkpoints.get(targetMessageUuid);
    if (!targetCheckpoint) {
      return {
        success: false,
        restoredFiles: [],
        deletedFiles: [],
        errors: [{ filePath: '', error: `Checkpoint not found: ${targetMessageUuid}` }],
      };
    }

    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    const errors: RewindError[] = [];

    const targetIndex = this.checkpointOrder.indexOf(targetMessageUuid);
    const checkpointsToRewind = this.checkpointOrder.slice(targetIndex + 1);

    const filesToRestore = new Map<string, FileSnapshot>();

    for (let i = checkpointsToRewind.length - 1; i >= 0; i--) {
      const checkpointUuid = checkpointsToRewind[i];
      const checkpoint = this.checkpoints.get(checkpointUuid);
      if (!checkpoint) continue;

      for (const change of checkpoint.fileChanges) {
        if (!filesToRestore.has(change.filePath) && change.beforeSnapshot) {
          filesToRestore.set(change.filePath, change.beforeSnapshot);
        }
      }
    }

    for (const [filePath, snapshot] of targetCheckpoint.fileSnapshots) {
      if (!filesToRestore.has(filePath)) {
        filesToRestore.set(filePath, snapshot);
      }
    }

    for (const [filePath, snapshot] of filesToRestore) {
      try {
        if (snapshot.exists && snapshot.content !== null) {
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(filePath, snapshot.content, 'utf-8');
          restoredFiles.push(filePath);
          logger.debug(`[CheckpointService] Restored: ${filePath}`);
        } else if (!snapshot.exists && existsSync(filePath)) {
          unlinkSync(filePath);
          deletedFiles.push(filePath);
          logger.debug(`[CheckpointService] Deleted: ${filePath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ filePath, error: message });
        logger.error(`[CheckpointService] Failed to restore ${filePath}: ${message}`);
      }
    }

    for (const checkpointUuid of checkpointsToRewind) {
      this.checkpoints.delete(checkpointUuid);
    }
    this.checkpointOrder = this.checkpointOrder.slice(0, targetIndex + 1);

    this.currentFileSnapshots = new Map(targetCheckpoint.fileSnapshots);
    this.pendingChanges = [];

    logger.info(
      `[CheckpointService] Rewound to ${targetMessageUuid}: restored=${restoredFiles.length}, deleted=${deletedFiles.length}, errors=${errors.length}`
    );

    return {
      success: errors.length === 0,
      restoredFiles,
      deletedFiles,
      errors,
    };
  }

  getChangedFilesSince(messageUuid: string): string[] {
    const targetIndex = this.checkpointOrder.indexOf(messageUuid);
    if (targetIndex === -1) {
      return [];
    }

    const changedFiles = new Set<string>();
    const checkpointsAfter = this.checkpointOrder.slice(targetIndex + 1);

    for (const checkpointUuid of checkpointsAfter) {
      const checkpoint = this.checkpoints.get(checkpointUuid);
      if (!checkpoint) continue;

      for (const change of checkpoint.fileChanges) {
        changedFiles.add(change.filePath);
      }
    }

    return Array.from(changedFiles);
  }

  getStatistics(): {
    checkpointCount: number;
    trackedFileCount: number;
    pendingChangeCount: number;
  } {
    return {
      checkpointCount: this.checkpoints.size,
      trackedFileCount: this.currentFileSnapshots.size,
      pendingChangeCount: this.pendingChanges.length,
    };
  }
}

export function getCheckpointService(): CheckpointService {
  return CheckpointService.getInstance();
}
