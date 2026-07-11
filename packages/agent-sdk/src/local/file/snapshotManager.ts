import * as crypto from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Snapshot metadata for a tracked file.
 */
export interface SnapshotMetadata {
  backupFileName: string;
  version: number;
  backupTime: Date;
}

/**
 * A single snapshot record stored in the in-memory index.
 */
export interface Snapshot {
  messageId: string;
  backupFileName: string;
  timestamp: Date;
  filePath: string;
}

/**
 * Configuration for {@link SnapshotManager}.
 */
export interface SnapshotManagerOptions {
  sessionId: string;
  /** SDK storage root. File snapshots are disabled when this is not provided. */
  storageRoot?: string;
  enableCheckpoints?: boolean;
  maxSnapshots?: number;
}

/**
 * Centralised file-snapshot manager.
 *
 * snapshotsDir is `undefined` when storage is disabled; every operation is a no-op in
 * that case.
 */
export class SnapshotManager {
  private readonly sessionId: string;
  private readonly maxSnapshots: number;
  private readonly snapshotDir: string | undefined;

  private trackedFileBackups = new Map<string, SnapshotMetadata>();
  private snapshots: Snapshot[] = [];

  constructor(options: SnapshotManagerOptions) {
    this.sessionId = options.sessionId;
    this.maxSnapshots = options.maxSnapshots ?? 10;

    this.snapshotDir =
      options.storageRoot && (options.enableCheckpoints ?? true)
        ? path.join(options.storageRoot, 'file-history', this.sessionId)
        : undefined;
  }

  /**
   * Initialise the snapshot directory. Safe to call even when storage is disabled.
   */
  async initialize(): Promise<void> {
    if (!this.snapshotDir) return;
    await mkdir(this.snapshotDir, { recursive: true, mode: 0o755 });
  }

  /**
   * Create a file snapshot for a specific message.
   */
  async createSnapshot(filePath: string, messageId: string): Promise<SnapshotMetadata> {
    if (!this.snapshotDir) {
      return { backupFileName: '', version: 0, backupTime: new Date() };
    }

    const fileExists = await pathExists(filePath);
    if (!fileExists) {
      return { backupFileName: '', version: 0, backupTime: new Date() };
    }

    const existing = this.trackedFileBackups.get(filePath);
    const version = existing ? existing.version + 1 : 1;
    const fileHash = this.generateFileHash(filePath, version);
    const snapshotPath = path.join(this.snapshotDir, `${fileHash}@v${version}`);

    const content = await readFile(filePath, { encoding: 'utf-8' });
    await writeFile(snapshotPath, content, { encoding: 'utf-8' });

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

    await this.cleanupOldSnapshots(filePath);
    return metadata;
  }

  /**
   * Restore a file to the state captured for a specific message.
   */
  async restoreSnapshot(filePath: string, messageId: string): Promise<void> {
    if (!this.snapshotDir) return;

    const snapshot = this.snapshots
      .slice()
      .reverse()
      .find((s) => s.messageId === messageId && s.filePath === filePath);

    if (!snapshot) {
      throw new Error(
        `No snapshot found: messageId=${messageId}, filePath=${filePath}`,
      );
    }

    const metadata = this.trackedFileBackups.get(filePath);
    if (!metadata) {
      throw new Error(`No tracked file metadata for: ${filePath}`);
    }

    const snapshotPath = path.join(
      this.snapshotDir,
      `${snapshot.backupFileName}@v${metadata.version}`,
    );

    const content = await readFile(snapshotPath, { encoding: 'utf-8' });
    await writeFile(filePath, content, { encoding: 'utf-8' });
  }

  /**
   * List all snapshots for a specific file.
   */
  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    return this.snapshots.filter((s) => s.filePath === filePath);
  }

  /**
   * Clean up all snapshots, keeping at most {@link keepCount} files in the directory.
   */
  async cleanup(keepCount = 0): Promise<void> {
    const dir = this.snapshotDir;
    if (!dir) return;

    const files = await readdir(dir);
    if (files.length <= keepCount) return;

    const filesWithStats = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dir, file);
        const st = await stat(filePath);
        return { file, mtime: st.mtime.getTime() };
      }),
    );

    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    const toDelete = filesWithStats.slice(keepCount);
    for (const { file } of toDelete) {
      await unlink(path.join(dir, file));
    }
  }

  // ---- private helpers ----

  private async cleanupOldSnapshots(filePath: string): Promise<void> {
    if (!this.snapshotDir) return;

    const fileSnapshots = this.snapshots.filter((s) => s.filePath === filePath);
    if (fileSnapshots.length <= this.maxSnapshots) return;

    const sorted = fileSnapshots.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const toDelete = sorted.slice(0, fileSnapshots.length - this.maxSnapshots);

    for (const snapshot of toDelete) {
      const metadata = this.trackedFileBackups.get(snapshot.filePath);
      if (!metadata) continue;

      const snapshotPath = path.join(
        this.snapshotDir,
        `${snapshot.backupFileName}@v${metadata.version}`,
      );

      try {
        await unlink(snapshotPath);
      } catch {
        // best-effort cleanup
      }

      const index = this.snapshots.indexOf(snapshot);
      if (index > -1) {
        this.snapshots.splice(index, 1);
      }
    }
  }

  private generateFileHash(filePath: string, version: number): string {
    const hash = crypto.createHash('md5');
    hash.update(`${filePath}:${version}`);
    return hash.digest('hex').substring(0, 16);
  }

  // ---- accessors ----

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
