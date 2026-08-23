import { open, readFile, stat, truncate, unlink } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { SdkError } from '../../errors/SdkError.js';
import type { JsonValue } from '../../types/common.js';
import { withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import type { SessionEvent } from '../types.js';

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SESSION_EVENT_TYPES = new Set([
  'session_created',
  'session_updated',
  'message_created',
  'part_created',
  'part_updated',
  'input_enqueued',
  'input_applied',
  'input_cancelled',
]);

export type JSONLStoreErrorCode =
  | 'SESSION_JSONL_CORRUPT_LOG'
  | 'SESSION_JSONL_LOCK_FAILED'
  | 'SESSION_JSONL_LOCK_TIMEOUT'
  | 'SESSION_JSONL_READ_FAILED'
  | 'SESSION_JSONL_WRITE_FAILED';

export class JSONLStoreError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the internal error-code contract
  constructor(
    code: JSONLStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

export interface JSONLStoreOptions {
  /** Maximum total time to wait for local or cross-process file ownership. */
  lockTimeoutMs?: number;
}

interface LoadedFile {
  entries: SessionEvent[];
  exists: boolean;
  committedBytes: number;
  totalBytes: number;
}

function isSessionEvent(data: unknown): data is SessionEvent {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.id === 'string'
    && typeof obj.sessionId === 'string'
    && typeof obj.timestamp === 'string'
    && typeof obj.type === 'string'
    && SESSION_EVENT_TYPES.has(obj.type)
    && typeof obj.version === 'string'
    && typeof obj.data === 'object'
    && obj.data !== null
    && !Array.isArray(obj.data);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

/**
 * JSONL storage for Session transcript events.
 *
 * Every operation is serialized across instances and local Node.js processes.
 * A trailing record without a newline is treated as an uncommitted crash tail;
 * the next append truncates it before writing. Corruption in any complete
 * record fails closed.
 */
export class JSONLStore {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly filePath: string,
    options: JSONLStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
      throw new JSONLStoreError(
        'SESSION_JSONL_LOCK_FAILED',
        'Session JSONL lockTimeoutMs must be a non-negative safe integer',
      );
    }
  }

  /** Append one committed JSONL record. */
  async append(entry: SessionEvent): Promise<void> {
    await this.appendEntries([entry]);
  }

  /** Append one committed batch without allowing records from other writers to interleave. */
  async appendBatch(entries: SessionEvent[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.appendEntries(entries);
  }

  /**
   * Append a record only when the file has no committed records.
   * Returns true when the record was written.
   */
  async appendIfEmpty(entry: SessionEvent): Promise<boolean> {
    const content = this.serializeEntries([entry]);
    return this.runWithLock('write', async () => {
      const loaded = await this.loadFileUnlocked();
      if (loaded.entries.length > 0) {
        return false;
      }
      await this.writeUnlocked(content, loaded);
      return true;
    });
  }

  /** Read all committed records. */
  async readAll(): Promise<SessionEvent[]> {
    return this.runWithLock('read', async () => {
      const loaded = await this.loadFileUnlocked();
      return loaded.entries;
    });
  }

  /** Read a stable snapshot and await each callback in file order. */
  async readStream(
    callback: (entry: SessionEvent) => void | Promise<void>,
  ): Promise<void> {
    const entries = await this.readAll();
    for (const entry of entries) {
      await callback(entry);
    }
  }

  async filter(
    predicate: (entry: SessionEvent) => boolean,
  ): Promise<SessionEvent[]> {
    const results: SessionEvent[] = [];
    await this.readStream((entry) => {
      if (predicate(entry)) {
        results.push(entry);
      }
    });
    return results;
  }

  async readLast(count: number): Promise<SessionEvent[]> {
    const all = await this.readAll();
    return all.slice(-count);
  }

  async getStats(): Promise<{
    exists: boolean;
    size: number;
    lineCount: number;
  }> {
    return this.runWithLock('read', async () => {
      const loaded = await this.loadFileUnlocked();
      return {
        exists: loaded.exists,
        size: loaded.totalBytes,
        lineCount: loaded.entries.length,
      };
    });
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.filePath);
      return true;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false;
      }
      throw new JSONLStoreError(
        'SESSION_JSONL_READ_FAILED',
        `Failed to inspect Session JSONL file ${this.filePath}`,
        { cause: error },
      );
    }
  }

  async delete(): Promise<void> {
    await this.runWithLock('write', async () => {
      try {
        await unlink(this.filePath);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw new JSONLStoreError(
            'SESSION_JSONL_WRITE_FAILED',
            `Failed to delete Session JSONL file ${this.filePath}`,
            { cause: error },
          );
        }
      }
    });
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async appendEntries(entries: readonly SessionEvent[]): Promise<void> {
    const content = this.serializeEntries(entries);
    await this.runWithLock('write', async () => {
      const loaded = await this.loadRawFileUnlocked();
      await this.writeUnlocked(content, loaded);
    });
  }

  private serializeEntries(entries: readonly SessionEvent[]): string {
    try {
      return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    } catch (error) {
      throw new JSONLStoreError(
        'SESSION_JSONL_WRITE_FAILED',
        `Failed to serialize Session JSONL records for ${this.filePath}`,
        { cause: error },
      );
    }
  }

  private async writeUnlocked(
    content: string,
    loaded: Pick<LoadedFile, 'committedBytes' | 'totalBytes'>,
  ): Promise<void> {
    try {
      if (loaded.totalBytes > loaded.committedBytes) {
        await truncate(this.filePath, loaded.committedBytes);
      }
      const file = await open(this.filePath, 'a', 0o600);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof JSONLStoreError) {
        throw error;
      }
      throw new JSONLStoreError(
        'SESSION_JSONL_WRITE_FAILED',
        `Failed to append Session JSONL records to ${this.filePath}`,
        { cause: error },
      );
    }
  }

  private async loadFileUnlocked(): Promise<LoadedFile> {
    const loaded = await this.loadRawFileUnlocked();
    let committed: string;
    try {
      committed = UTF8_DECODER.decode(
        loaded.bytes.subarray(0, loaded.committedBytes),
      );
    } catch (error) {
      throw new JSONLStoreError(
        'SESSION_JSONL_CORRUPT_LOG',
        `Session JSONL file contains invalid UTF-8: ${this.filePath}`,
        { cause: error },
      );
    }
    const entries: SessionEvent[] = [];
    const eventIds = new Set<string>();
    let sessionId: string | undefined;
    for (const [index, line] of committed.split('\n').entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed: JsonValue = JSON.parse(line) as JsonValue;
        if (!isSessionEvent(parsed)) {
          throw new Error('Record is not a SessionEvent');
        }
        if (eventIds.has(parsed.id)) {
          throw new Error(`Duplicate Session event ID: ${parsed.id}`);
        }
        if (sessionId !== undefined && parsed.sessionId !== sessionId) {
          throw new Error(
            `Session ID changed from ${sessionId} to ${parsed.sessionId}`,
          );
        }
        eventIds.add(parsed.id);
        sessionId ??= parsed.sessionId;
        entries.push(parsed);
      } catch (error) {
        throw new JSONLStoreError(
          'SESSION_JSONL_CORRUPT_LOG',
          `Invalid Session JSONL record at line ${index + 1} in ${this.filePath}`,
          { cause: error },
        );
      }
    }
    return {
      entries,
      exists: loaded.exists,
      committedBytes: loaded.committedBytes,
      totalBytes: loaded.totalBytes,
    };
  }

  private async loadRawFileUnlocked(): Promise<{
    bytes: Buffer;
    exists: boolean;
    committedBytes: number;
    totalBytes: number;
  }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return {
          bytes: Buffer.alloc(0),
          exists: false,
          committedBytes: 0,
          totalBytes: 0,
        };
      }
      throw new JSONLStoreError(
        'SESSION_JSONL_READ_FAILED',
        `Failed to read Session JSONL file ${this.filePath}`,
        { cause: error },
      );
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    return {
      bytes,
      exists: true,
      committedBytes: lastNewline === -1 ? 0 : lastNewline + 1,
      totalBytes: bytes.length,
    };
  }

  private runWithLock<T>(
    operation: 'read' | 'write',
    callback: () => Promise<T>,
  ): Promise<T> {
    const operationErrorCode =
      operation === 'write' ? 'SESSION_JSONL_WRITE_FAILED' : 'SESSION_JSONL_READ_FAILED';
    return withAdvisoryFileLock(
      this.filePath,
      {
        timeoutMs: this.lockTimeoutMs,
        errors: {
          prepare: (cause) =>
            new JSONLStoreError(
              'SESSION_JSONL_LOCK_FAILED',
              `Failed to prepare Session JSONL lock for ${this.filePath}`,
              { cause },
            ),
          initialize: (cause) =>
            new JSONLStoreError(
              'SESSION_JSONL_LOCK_FAILED',
              `Failed to initialize Session JSONL lock for ${this.filePath}`,
              { cause },
            ),
          acquire: (cause) =>
            new JSONLStoreError(
              'SESSION_JSONL_LOCK_FAILED',
              `Failed to acquire Session JSONL lock for ${this.filePath}`,
              { cause },
            ),
          timeout: () =>
            new JSONLStoreError(
              'SESSION_JSONL_LOCK_TIMEOUT',
              `Timed out acquiring Session JSONL lock for ${this.filePath}`,
            ),
          release: (cause) =>
            new JSONLStoreError(
              operationErrorCode,
              `Session JSONL ${operation} failed while holding the file lock for ${this.filePath}`,
              { cause },
            ),
        },
      },
      callback,
    );
  }
}
