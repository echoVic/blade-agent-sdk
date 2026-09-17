import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../../logging/Logger.js';
import type { SessionId } from '../../../types/identifiers.js';
import { getErrorCode, getErrorMessage } from '../../../utils/errorUtils.js';

interface FileFingerprint {
  identity: string;
  contentHash: string;
}

export interface FileAccessRecord {
  filePath: string;
  accessTime: number;
  mtime: number;
  sessionId: SessionId;
  lastOperation: 'read' | 'edit' | 'write';
  fingerprint: FileFingerprint;
}

const instances = { current: null as FileAccessTracker | null };

export class FileAccessTracker {
  private readonly records = new Map<string, FileAccessRecord>();
  private logger = NOOP_LOGGER.child(LogCategory.TOOL);

  private constructor(
    private readonly maxTrackedFiles = 1000,
    private readonly recordTtlMs = 60 * 60_000,
  ) {
    if (!Number.isSafeInteger(maxTrackedFiles) || maxTrackedFiles < 1) {
      throw new RangeError('maxTrackedFiles must be a positive safe integer');
    }
    if (!Number.isSafeInteger(recordTtlMs) || recordTtlMs < 1) {
      throw new RangeError('recordTtlMs must be a positive safe integer');
    }
  }

  static getInstance(
    logger?: InternalLogger,
    maxTrackedFiles?: number,
    recordTtlMs?: number,
  ): FileAccessTracker {
    instances.current ??= new FileAccessTracker(maxTrackedFiles, recordTtlMs);
    if (logger) instances.current.setLogger(logger);
    return instances.current;
  }

  static resetInstance(): void {
    instances.current = null;
  }

  static clearSessionRecords(sessionId: SessionId): void {
    instances.current?.clearSession(sessionId);
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.TOOL);
  }

  async recordFileRead(
    filePath: string,
    sessionId: SessionId,
    content?: string | Uint8Array,
  ): Promise<void> {
    await this.capture(filePath, sessionId, 'read', content);
  }

  async recordFileEdit(
    filePath: string,
    sessionId: SessionId,
    operation: 'edit' | 'write' = 'edit',
  ): Promise<void> {
    await this.capture(filePath, sessionId, operation);
  }

  hasFileBeenRead(filePath: string, sessionId?: string): boolean {
    return this.findRecord(filePath, sessionId) !== undefined;
  }

  getFileRecord(filePath: string, sessionId?: SessionId): FileAccessRecord | undefined {
    return this.findRecord(filePath, sessionId);
  }

  async checkFileModification(
    filePath: string,
    sessionId?: SessionId,
  ): Promise<{ modified: boolean; message?: string }> {
    const result = await this.checkModification(filePath, sessionId);
    return { modified: result.changed, message: result.message };
  }

  async checkExternalModification(
    filePath: string,
    sessionId?: SessionId,
  ): Promise<{ isExternal: boolean; message?: string }> {
    const result = await this.checkModification(filePath, sessionId);
    return { isExternal: result.changed, message: result.message };
  }

  clearFileRecord(filePath: string, sessionId?: SessionId): void {
    if (sessionId) {
      this.records.delete(this.key(filePath, sessionId));
      return;
    }
    for (const [key, record] of this.records) {
      if (record.filePath === filePath) this.records.delete(key);
    }
  }

  clearSession(sessionId: SessionId): void {
    for (const [key, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(key);
    }
  }

  clearAll(): void {
    this.records.clear();
  }

  getTrackedFiles(): string[] {
    this.pruneExpired();
    return [...new Set([...this.records.values()].map(({ filePath }) => filePath))];
  }

  getTrackedFileCount(): number {
    this.pruneExpired();
    return this.records.size;
  }

  private async capture(
    filePath: string,
    sessionId: SessionId,
    lastOperation: FileAccessRecord['lastOperation'],
    content?: string | Uint8Array,
  ): Promise<void> {
    try {
      const fileStats = await stat(filePath, { bigint: true });
      const fingerprint = this.fingerprint(fileStats, content ?? (await readFile(filePath)));
      const record: FileAccessRecord = {
        filePath,
        sessionId,
        lastOperation,
        accessTime: Date.now(),
        mtime: Number(fileStats.mtimeNs) / 1_000_000,
        fingerprint,
      };
      this.pruneExpired();
      const key = this.key(filePath, sessionId);
      this.records.delete(key);
      this.records.set(key, record);
      while (this.records.size > this.maxTrackedFiles) {
        const oldest = this.records.keys().next().value;
        if (oldest === undefined) break;
        this.records.delete(oldest);
      }
    } catch (error) {
      this.logger.warn(`Failed to record file ${lastOperation}: ${filePath}`, error);
    }
  }

  private async checkModification(
    filePath: string,
    sessionId?: SessionId,
  ): Promise<{ changed: boolean; message?: string }> {
    const record = this.findRecord(filePath, sessionId);
    if (!record) return { changed: false, message: '文件未被跟踪' };
    try {
      const fileStats = await stat(filePath, { bigint: true });
      const current = this.fingerprint(fileStats, await readFile(filePath));
      return this.sameFingerprint(record.fingerprint, current)
        ? { changed: false }
        : {
            changed: true,
            message: `文件在 ${new Date(record.accessTime).toISOString()} (${record.lastOperation}) 之后被修改`,
          };
    } catch (error) {
      return {
        changed: true,
        message:
          getErrorCode(error) === 'ENOENT'
            ? '文件已被删除'
            : `无法验证文件状态: ${getErrorMessage(error)}`,
      };
    }
  }

  private findRecord(filePath: string, sessionId?: string): FileAccessRecord | undefined {
    this.pruneExpired();
    if (sessionId) return this.records.get(this.key(filePath, sessionId));
    return [...this.records.values()]
      .filter((record) => record.filePath === filePath)
      .sort((left, right) => right.accessTime - left.accessTime)[0];
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.recordTtlMs;
    for (const [key, record] of this.records) {
      if (record.accessTime <= cutoff) this.records.delete(key);
    }
  }

  private key(filePath: string, sessionId: string): string {
    return JSON.stringify([sessionId, filePath]);
  }

  private fingerprint(
    stats: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
    content: string | Uint8Array,
  ): FileFingerprint {
    return {
      identity: [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':'),
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
  }

  private sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
    return left.identity === right.identity && left.contentHash === right.contentHash;
  }
}
