import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { SdkError } from '../../errors/SdkError.js';
import {
  ProjectedSessionRepository,
  type SessionState,
  type SessionStateMutation,
} from '../../session/SessionStore.js';
import { SessionId } from '../../types/identifiers.js';
import { syncParentDirectory, withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import { getSessionFilePathFromStorageRoot, normalizeSessionStorageRoot } from './pathUtils.js';

const LOCK_TIMEOUT_MS = 10_000;

class SessionFileError extends SdkError {}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function parseState(value: unknown, sessionId: SessionId): SessionState {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('sessionId' in value) ||
    value.sessionId !== sessionId ||
    !('messages' in value) ||
    !Array.isArray(value.messages) ||
    !('timeline' in value) ||
    !Array.isArray(value.timeline)
  ) {
    throw new SessionFileError(
      'SESSION_JSONL_CORRUPT_LOG',
      `Invalid Session projection for ${sessionId}`,
    );
  }
  return structuredClone(value) as SessionState;
}

export class PersistentStore extends ProjectedSessionRepository {
  private readonly storageRoot: string;

  constructor(
    storageRoot: string,
    private readonly maxSessions = 100,
    private readonly projectPath?: string,
  ) {
    super();
    this.storageRoot = normalizeSessionStorageRoot(storageRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
  }

  protected readState(sessionId: SessionId): Promise<SessionState | null> {
    return this.lock(sessionId, () => this.read(sessionId));
  }

  protected updateState<T>(
    sessionId: SessionId,
    create: () => SessionState,
    mutation: SessionStateMutation<T>,
  ): Promise<T> {
    return this.lock(sessionId, async () => {
      const state = (await this.read(sessionId)) ?? create();
      const result = mutation(state, Date.now());
      await this.write(state);
      return result;
    });
  }

  async listSessions(): Promise<SessionId[]> {
    try {
      return (await readdir(this.storageRoot, { withFileTypes: true }))
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => SessionId(file.name.slice(0, -'.jsonl'.length)))
        .sort();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    await this.lock(sessionId, async () => {
      await unlink(this.path(sessionId)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    });
  }

  async cleanupOldSessions(): Promise<void> {
    const summaries = (
      await Promise.all((await this.listSessions()).map((id) => this.getSessionSummary(id)))
    )
      .filter((summary) => summary !== null)
      .sort((left, right) => right.lastActivity - left.lastActivity);
    await Promise.all(
      summaries.slice(this.maxSessions).map(({ sessionId }) => this.deleteSession(sessionId)),
    );
  }

  async getStorageStats() {
    const sessions = await this.listSessions();
    const sizes = await Promise.all(
      sessions.map((sessionId) => stat(this.path(sessionId)).then(({ size }) => size)),
    );
    return {
      totalSessions: sessions.length,
      totalSize: sizes.reduce((total, size) => total + size, 0),
      ...(this.projectPath ? { projectPath: this.projectPath } : {}),
    };
  }

  async checkStorageHealth() {
    const probe = join(this.storageRoot, '.health-check');
    try {
      await this.initialize();
      await writeFile(probe, 'test', { encoding: 'utf8', mode: 0o600 });
      await unlink(probe);
      return { isAvailable: true, canWrite: true };
    } catch (error) {
      return {
        isAvailable: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private path(sessionId: SessionId): string {
    return getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
  }

  private async read(sessionId: SessionId): Promise<SessionState | null> {
    try {
      return parseState(JSON.parse(await readFile(this.path(sessionId), 'utf8')), sessionId);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      if (error instanceof SessionFileError) throw error;
      if (error instanceof SyntaxError) {
        throw new SessionFileError(
          'SESSION_JSONL_CORRUPT_LOG',
          `Invalid Session projection for ${sessionId}`,
          { cause: error },
        );
      }
      throw new SessionFileError(
        'SESSION_JSONL_READ_FAILED',
        `Failed to read Session projection ${this.path(sessionId)}`,
        { cause: error },
      );
    }
  }

  private async write(state: SessionState): Promise<void> {
    const filePath = this.path(state.sessionId);
    const existed = await stat(filePath)
      .then(() => true)
      .catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
      });
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFileAtomic(filePath, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        fsync: true,
        mode: 0o600,
      });
      if (!existed) await syncParentDirectory(filePath);
    } catch (error) {
      throw new SessionFileError(
        'SESSION_JSONL_WRITE_FAILED',
        `Failed to write Session projection ${filePath}`,
        { cause: error },
      );
    }
  }

  private lock<T>(sessionId: SessionId, callback: () => Promise<T>): Promise<T> {
    const filePath = this.path(sessionId);
    const lockError = (action: string, cause: unknown) =>
      new SessionFileError(
        'SESSION_JSONL_LOCK_FAILED',
        `Failed to ${action} Session projection lock ${filePath}`,
        { cause },
      );
    return withAdvisoryFileLock(
      filePath,
      {
        timeoutMs: LOCK_TIMEOUT_MS,
        errors: {
          prepare: (cause) => lockError('prepare', cause),
          initialize: (cause) => lockError('initialize', cause),
          acquire: (cause) => lockError('acquire', cause),
          release: (cause) => lockError('release', cause),
          timeout: () =>
            new SessionFileError(
              'SESSION_JSONL_LOCK_TIMEOUT',
              `Timed out locking Session projection ${filePath}`,
            ),
        },
      },
      callback,
    );
  }
}
