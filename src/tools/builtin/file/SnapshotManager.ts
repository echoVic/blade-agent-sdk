import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MessageId, SessionId } from '../../../types/branded.js';

/**
 * 快照元数据
 */
export interface SnapshotMetadata {
  backupFileName: string; // 文件哈希（如 "0e524d000ce5f33d"）
  version: number; // 当前版本号
  backupTime: Date; // 备份时间
}

/**
 * 快照记录
 */
export interface Snapshot {
  messageId: MessageId; // 对应的对话消息 ID
  backupFileName: string; // 快照文件哈希
  timestamp: Date; // 创建时间
  filePath: string; // 原始文件路径
}

/**
 * 快照管理器配置
 */
export interface SnapshotManagerOptions {
  sessionId: SessionId;
  /** SDK 数据存储根目录。不提供时禁用文件快照。 */
  storageRoot?: string;
  enableCheckpoints?: boolean;
  maxSnapshots?: number;
}

/**
 * 集中式快照管理器
 *
 * snapshotDir 有值时启用文件快照，undefined 时所有操作为 no-op。
 */
export class SnapshotManager {
  private readonly sessionId: SessionId;
  private readonly maxSnapshots: number;
  private readonly snapshotDir: string | undefined;

  // 已追踪文件备份映射
  private trackedFileBackups: Map<string, SnapshotMetadata> = new Map();

  // 快照历史数组
  private snapshots: Snapshot[] = [];

  constructor(options: SnapshotManagerOptions) {
    this.sessionId = options.sessionId;
    this.maxSnapshots = options.maxSnapshots ?? 10;

    // 只有提供了 storageRoot 且未显式禁用时才启用文件快照
    this.snapshotDir =
      options.storageRoot && (options.enableCheckpoints ?? true)
        ? path.join(options.storageRoot, 'file-history', this.sessionId)
        : undefined;
  }

  /**
   * 初始化快照目录
   */
  async initialize(): Promise<void> {
    if (!this.snapshotDir) return;

    try {
      await fs.mkdir(this.snapshotDir, { recursive: true, mode: 0o755 });
      console.log(`[SnapshotManager] 初始化快照目录: ${this.snapshotDir}`);
    } catch (error) {
      console.warn('[SnapshotManager] 创建快照目录失败:', error);
      throw error;
    }
  }

  /**
   * 创建文件快照
   */
  async createSnapshot(filePath: string, messageId: MessageId): Promise<SnapshotMetadata> {
    if (!this.snapshotDir) {
      return { backupFileName: '', version: 0, backupTime: new Date() };
    }

    try {
      await fs.access(filePath);
    } catch {
      console.warn(`[SnapshotManager] 文件不存在，跳过快照: ${filePath}`);
      return { backupFileName: '', version: 0, backupTime: new Date() };
    }

    const existing = this.trackedFileBackups.get(filePath);
    const version = existing ? existing.version + 1 : 1;
    const fileHash = this.generateFileHash(filePath, version);
    const snapshotPath = path.join(this.snapshotDir, `${fileHash}@v${version}`);

    try {
      const content = await fs.readFile(filePath, { encoding: 'utf-8' });
      await fs.writeFile(snapshotPath, content, { encoding: 'utf-8' });

      const metadata: SnapshotMetadata = {
        backupFileName: fileHash,
        version,
        backupTime: new Date(),
      };

      this.trackedFileBackups.set(filePath, metadata);
      this.snapshots.push({
        messageId,
        backupFileName: fileHash,
        timestamp: new Date(),
        filePath,
      });

      console.log(`[SnapshotManager] 创建快照: ${filePath} -> ${fileHash}@v${version}`);
      await this.cleanupOldSnapshots(filePath);

      return metadata;
    } catch (error) {
      console.error(`[SnapshotManager] 创建快照失败: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 恢复文件快照
   */
  async restoreSnapshot(filePath: string, messageId: MessageId): Promise<void> {
    if (!this.snapshotDir) return;

    const snapshot = this.snapshots
      .slice()
      .reverse()
      .find((s) => s.messageId === messageId && s.filePath === filePath);

    if (!snapshot) {
      throw new Error(`未找到快照: messageId=${messageId}, filePath=${filePath}`);
    }

    const metadata = this.trackedFileBackups.get(filePath);
    if (!metadata) {
      throw new Error(`未找到文件追踪信息: ${filePath}`);
    }

    const snapshotPath = path.join(
      this.snapshotDir,
      `${snapshot.backupFileName}@v${metadata.version}`
    );

    try {
      const content = await fs.readFile(snapshotPath, { encoding: 'utf-8' });
      await fs.writeFile(filePath, content, { encoding: 'utf-8' });
      console.log(
        `[SnapshotManager] 恢复快照: ${filePath} <- ${snapshot.backupFileName}@v${metadata.version}`
      );
    } catch (error) {
      console.error(`[SnapshotManager] 恢复快照失败: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 列出文件的所有快照
   */
  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    return this.snapshots.filter((s) => s.filePath === filePath);
  }

  /**
   * 清理文件的旧快照（保留最近的 N 个）
   */
  private async cleanupOldSnapshots(filePath: string): Promise<void> {
    if (!this.snapshotDir) return;

    const fileSnapshots = this.snapshots.filter((s) => s.filePath === filePath);
    if (fileSnapshots.length <= this.maxSnapshots) return;

    const sortedSnapshots = fileSnapshots.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    const toDelete = sortedSnapshots.slice(0, fileSnapshots.length - this.maxSnapshots);

    for (const snapshot of toDelete) {
      const metadata = this.trackedFileBackups.get(snapshot.filePath);
      if (!metadata) continue;

      const snapshotPath = path.join(
        this.snapshotDir,
        `${snapshot.backupFileName}@v${metadata.version}`
      );

      try {
        await fs.unlink(snapshotPath);
        console.log(`[SnapshotManager] 删除旧快照: ${snapshotPath}`);
      } catch (error) {
        console.warn(`[SnapshotManager] 删除快照失败: ${snapshotPath}`, error);
      }

      const index = this.snapshots.indexOf(snapshot);
      if (index > -1) {
        this.snapshots.splice(index, 1);
      }
    }
  }

  /**
   * 清理所有快照（会话结束时调用）
   */
  async cleanup(keepCount: number = 0): Promise<void> {
    const { snapshotDir } = this;
    if (!snapshotDir) return;

    try {
      const files = await fs.readdir(snapshotDir);
      if (files.length <= keepCount) return;

      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(snapshotDir, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime.getTime() };
        })
      );

      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      const toDelete = filesWithStats.slice(keepCount);
      for (const { file } of toDelete) {
        const filePath = path.join(snapshotDir, file);
        await fs.unlink(filePath);
        console.log(`[SnapshotManager] 清理快照: ${filePath}`);
      }
    } catch (error) {
      console.warn('[SnapshotManager] 清理快照失败:', error);
    }
  }

  private generateFileHash(filePath: string, version: number): string {
    const hash = crypto.createHash('md5');
    hash.update(`${filePath}:${version}`);
    return hash.digest('hex').substring(0, 16);
  }

  getSnapshotDir(): string | undefined {
    return this.snapshotDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTrackedFileCount(): number {
    return this.trackedFileBackups.size;
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }
}
