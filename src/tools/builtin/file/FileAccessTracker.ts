import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../../logging/Logger.js';
import type { SessionId } from '../../../types/identifiers.js';
import { getErrorCode, getErrorMessage } from '../../../utils/errorUtils.js';

/**
 * 文件访问记录
 */
export interface FileAccessRecord {
  filePath: string; // 文件绝对路径
  accessTime: number; // 最后访问时间戳（毫秒）- 包括 read/edit/write
  mtime: number; // 访问时文件的修改时间戳
  sessionId: SessionId; // 会话 ID
  lastOperation: 'read' | 'edit' | 'write'; // 最后操作类型
  fingerprint: FileFingerprint;
}

interface FileFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly contentHash: string;
}

const DEFAULT_MAX_TRACKED_FILES = 1_000;
const DEFAULT_RECORD_TTL_MS = 60 * 60_000;
/**
 * 文件访问跟踪器
 *
 * 功能：
 * 1. 跟踪已读文件的时间戳
 * 2. 验证编辑前文件是否已通过 Read 工具读取
 * 3. 检查文件修改时间是否晚于读取时间（防止并发编辑）
 */
export class FileAccessTracker {
  // 全局单例实例
  private static instance: FileAccessTracker | null = null;
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.TOOL);

  // 已读文件映射: sessionId + filePath -> FileAccessRecord
  private accessedFiles: Map<string, FileAccessRecord> = new Map();

  private constructor(
    private readonly maxTrackedFiles = DEFAULT_MAX_TRACKED_FILES,
    private readonly recordTtlMs = DEFAULT_RECORD_TTL_MS,
  ) {
    if (!Number.isSafeInteger(maxTrackedFiles) || maxTrackedFiles < 1) {
      throw new RangeError('maxTrackedFiles must be a positive safe integer');
    }
    if (!Number.isSafeInteger(recordTtlMs) || recordTtlMs < 1) {
      throw new RangeError('recordTtlMs must be a positive safe integer');
    }
  }

  /**
   * 获取全局单例实例
   */
  static getInstance(
    logger?: InternalLogger,
    maxTrackedFiles?: number,
    recordTtlMs?: number,
  ): FileAccessTracker {
    if (!FileAccessTracker.instance) {
      FileAccessTracker.instance = new FileAccessTracker(maxTrackedFiles, recordTtlMs);
    }
    if (logger) {
      FileAccessTracker.instance.setLogger(logger);
    }
    return FileAccessTracker.instance;
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.TOOL);
  }

  /**
   * 记录文件读取
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID
   */
  async recordFileRead(
    filePath: string,
    sessionId: SessionId,
    content?: string | Uint8Array,
  ): Promise<void> {
    try {
      // 获取文件的当前修改时间
      const stats = await fs.stat(filePath, { bigint: true });
      const capturedContent = content ?? (await fs.readFile(filePath));

      const record: FileAccessRecord = {
        filePath,
        accessTime: Date.now(),
        mtime: Number(stats.mtimeNs) / 1_000_000,
        sessionId,
        lastOperation: 'read',
        fingerprint: this.toFingerprint(stats, capturedContent),
      };

      this.setRecord(record);

      this.logger.debug(`记录文件读取: ${filePath}`);
    } catch (error) {
      this.logger.warn(`记录文件读取失败: ${filePath}`, error);
    }
  }

  /**
   * 记录文件编辑操作
   * 在 Edit/Write 工具成功执行后调用，更新文件的访问时间和 mtime
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID
   * @param operation 操作类型（'edit' 或 'write'）
   */
  async recordFileEdit(
    filePath: string,
    sessionId: SessionId,
    operation: 'edit' | 'write' = 'edit',
  ): Promise<void> {
    try {
      // 获取文件的当前修改时间
      const stats = await fs.stat(filePath, { bigint: true });
      const content = await fs.readFile(filePath);

      const record: FileAccessRecord = {
        filePath,
        accessTime: Date.now(),
        mtime: Number(stats.mtimeNs) / 1_000_000,
        sessionId,
        lastOperation: operation,
        fingerprint: this.toFingerprint(stats, content),
      };

      this.setRecord(record);

      this.logger.debug(`记录文件${operation === 'edit' ? '编辑' : '写入'}: ${filePath}`);
    } catch (error) {
      this.logger.warn(`记录文件${operation === 'edit' ? '编辑' : '写入'}失败: ${filePath}`, error);
    }
  }

  /**
   * 验证文件是否已读取
   *
   * @param filePath 文件绝对路径
   * @param sessionId 会话 ID（可选，用于会话隔离）
   * @returns 是否已读取
   */
  hasFileBeenRead(filePath: string, sessionId?: string): boolean {
    const record = this.findRecord(filePath, sessionId);

    if (!record) {
      return false;
    }

    return true;
  }

  /**
   * 验证文件是否在读取后被修改
   *
   * @param filePath 文件绝对路径
   * @returns { modified: boolean, message?: string }
   */
  async checkFileModification(
    filePath: string,
    sessionId?: SessionId,
  ): Promise<{ modified: boolean; message?: string }> {
    const record = this.findRecord(filePath, sessionId);

    if (!record) {
      return {
        modified: false,
        message: '文件未被跟踪',
      };
    }

    try {
      // 获取文件当前的修改时间
      const stats = await fs.stat(filePath, { bigint: true });
      const content = await fs.readFile(filePath);

      if (!this.sameFingerprint(record.fingerprint, this.toFingerprint(stats, content))) {
        return {
          modified: true,
          message: `文件在访问后被修改（访问时间: ${new Date(record.accessTime).toISOString()}, 当前修改时间: ${new Date(Number(stats.mtimeNs) / 1_000_000).toISOString()}）`,
        };
      }

      return { modified: false };
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return {
          modified: true,
          message: '文件已被删除',
        };
      }

      return {
        modified: true,
        message: `无法验证文件状态: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * 检查文件是否被外部程序修改
   * 对比文件 mtime 与我们最后操作时间
   *
   * @param filePath 文件绝对路径
   * @returns { isExternal: boolean, message?: string }
   */
  async checkExternalModification(
    filePath: string,
    sessionId?: SessionId,
  ): Promise<{ isExternal: boolean; message?: string }> {
    const record = this.findRecord(filePath, sessionId);

    if (!record) {
      return {
        isExternal: false,
        message: '文件未被跟踪',
      };
    }

    try {
      // 获取文件当前的修改时间
      const stats = await fs.stat(filePath, { bigint: true });
      const content = await fs.readFile(filePath);
      if (!this.sameFingerprint(record.fingerprint, this.toFingerprint(stats, content))) {
        return {
          isExternal: true,
          message: `文件在 ${new Date(record.accessTime).toISOString()} (${record.lastOperation}) 之后被外部程序修改（当前修改时间: ${new Date(Number(stats.mtimeNs) / 1_000_000).toISOString()}）`,
        };
      }

      return { isExternal: false };
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return {
          isExternal: true,
          message: '文件已被删除',
        };
      }

      this.logger.warn(`检查文件外部修改失败: ${filePath}`, error);
      return {
        isExternal: true,
        message: `无法验证文件状态: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * 获取文件的访问记录
   *
   * @param filePath 文件绝对路径
   * @returns 访问记录或 undefined
   */
  getFileRecord(filePath: string, sessionId?: SessionId): FileAccessRecord | undefined {
    return this.findRecord(filePath, sessionId);
  }

  /**
   * 清除文件的访问记录
   *
   * @param filePath 文件绝对路径
   */
  clearFileRecord(filePath: string, sessionId?: SessionId): void {
    if (sessionId) {
      this.accessedFiles.delete(this.recordKey(filePath, sessionId));
      return;
    }
    for (const [key, record] of this.accessedFiles) {
      if (record.filePath === filePath) {
        this.accessedFiles.delete(key);
      }
    }
  }

  /**
   * 清除所有访问记录
   */
  clearAll(): void {
    this.accessedFiles.clear();
  }

  /**
   * 清除指定会话的所有访问记录
   *
   * @param sessionId 会话 ID
   */
  clearSession(sessionId: SessionId): void {
    for (const [filePath, record] of this.accessedFiles.entries()) {
      if (record.sessionId === sessionId) {
        this.accessedFiles.delete(filePath);
      }
    }
  }

  /**
   * 获取所有已跟踪的文件路径
   */
  getTrackedFiles(): string[] {
    this.pruneExpired();
    return [...new Set(Array.from(this.accessedFiles.values(), (record) => record.filePath))];
  }

  /**
   * 获取跟踪的文件数量
   */
  getTrackedFileCount(): number {
    this.pruneExpired();
    return this.accessedFiles.size;
  }

  /**
   * 重置单例实例（仅用于测试）
   */
  static resetInstance(): void {
    FileAccessTracker.instance = null;
  }

  static clearSessionRecords(sessionId: SessionId): void {
    FileAccessTracker.instance?.clearSession(sessionId);
  }

  private recordKey(filePath: string, sessionId: string): string {
    return JSON.stringify([sessionId, filePath]);
  }

  private setRecord(record: FileAccessRecord): void {
    this.pruneExpired();
    const key = this.recordKey(record.filePath, record.sessionId);
    this.accessedFiles.delete(key);
    this.accessedFiles.set(key, record);
    while (this.accessedFiles.size > this.maxTrackedFiles) {
      const oldest = this.accessedFiles.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.accessedFiles.delete(oldest);
    }
  }

  private findRecord(filePath: string, sessionId?: string): FileAccessRecord | undefined {
    this.pruneExpired();
    if (sessionId) {
      return this.accessedFiles.get(this.recordKey(filePath, sessionId));
    }
    return Array.from(this.accessedFiles.values())
      .filter((record) => record.filePath === filePath)
      .sort((left, right) => right.accessTime - left.accessTime)[0];
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.recordTtlMs;
    for (const [key, record] of this.accessedFiles) {
      if (record.accessTime <= cutoff) {
        this.accessedFiles.delete(key);
      }
    }
  }

  private toFingerprint(
    stats: {
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    },
    content: string | Uint8Array,
  ): FileFingerprint {
    return {
      device: String(stats.dev),
      inode: String(stats.ino),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      ctimeNs: String(stats.ctimeNs),
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
  }

  private sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
    return (
      left.device === right.device &&
      left.inode === right.inode &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs &&
      left.contentHash === right.contentHash
    );
  }
}
