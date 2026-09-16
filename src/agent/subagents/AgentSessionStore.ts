import fs from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ConversationMessage } from '../../model/conversation.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import { AgentId } from '../../types/identifiers.js';
import { syncParentDirectory, withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import type { AgentProgress } from '../types.js';
import type { AgentSessionRepository } from './AgentSessionRepository.js';

const LOCK_TIMEOUT_MS = 10_000;

export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentSession {
  id: AgentId;
  subagentType: string;
  description: string;
  prompt: string;
  messages: ConversationMessage[];
  status: AgentSessionStatus;
  result?: { success: boolean; message: string; error?: string };
  stats?: { tokens?: number; toolCalls?: number; duration?: number };
  createdAt: number;
  lastActiveAt: number;
  completedAt?: number;
  parentSessionId?: string;
  progress?: AgentProgress;
  executionFence?: DurableExecutionFence;
}

export class AgentSessionStore implements AgentSessionRepository {
  private logger: InternalLogger;
  private readonly directory?: string;
  private readonly cache = new Map<AgentId, AgentSession>();

  constructor(storageRoot?: string, logger: InternalLogger = NOOP_LOGGER) {
    this.logger = logger.child(LogCategory.AGENT);
    this.directory = storageRoot ? path.join(storageRoot, 'agents', 'sessions') : undefined;
    if (this.directory) fs.mkdirSync(this.directory, { recursive: true, mode: 0o755 });
  }

  static create(storageRoot?: string, logger?: InternalLogger): AgentSessionStore {
    return new AgentSessionStore(storageRoot, logger);
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
  }

  async saveSession(session: AgentSession): Promise<boolean> {
    return this.withLock(session.id, 'write', async () => {
      const current = this.read(session.id);
      if (current && !this.canReplace(current.executionFence, session.executionFence)) return false;
      await this.write(session);
      return true;
    });
  }

  async loadSession(agentId: AgentId): Promise<AgentSession | undefined> {
    return this.read(agentId);
  }

  updateSession(
    agentId: AgentId,
    updates: Partial<AgentSession>,
    fence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.update(agentId, updates, fence);
  }

  updateRunningSession(
    agentId: AgentId,
    updates: { messages?: ConversationMessage[]; progress?: AgentProgress },
    fence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.update(agentId, updates, fence, true);
  }

  markCompleted(
    agentId: AgentId,
    result: NonNullable<AgentSession['result']>,
    stats?: AgentSession['stats'],
    fence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.finish(agentId, result.success ? 'completed' : 'failed', result, stats, fence);
  }

  markCancelled(
    agentId: AgentId,
    result: NonNullable<AgentSession['result']> = { success: false, message: '' },
    stats?: AgentSession['stats'],
    fence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.finish(agentId, 'cancelled', result, stats, fence);
  }

  async deleteSession(agentId: AgentId, fence?: DurableExecutionFence): Promise<boolean> {
    try {
      return await this.withLock(agentId, 'write', async () => {
        const session = this.read(agentId);
        if (session && !this.sameFence(session.executionFence, fence)) return false;
        await this.remove(agentId);
        return true;
      });
    } catch (error) {
      this.logger.warn(`Failed to delete session ${agentId}:`, error);
      return false;
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    if (!this.directory) return this.sorted([...this.cache.values()]);
    try {
      const sessions = await Promise.all(
        fs
          .readdirSync(this.directory)
          .filter((file) => file.endsWith('.json'))
          .map((file) => this.loadSession(AgentId(file.slice(0, -5)))),
      );
      return this.sorted(sessions.filter((session) => session !== undefined));
    } catch (error) {
      this.logger.warn('Failed to list sessions:', error);
      return [];
    }
  }

  async listRunningSessions(): Promise<AgentSession[]> {
    return (await this.listSessions()).filter((session) => session.status === 'running');
  }

  async cleanupExpiredSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const expired = (await this.listSessions()).filter(
      (session) => session.status !== 'running' && session.lastActiveAt < cutoff,
    );
    const deleted = await Promise.all(expired.map((session) => this.deleteTerminal(session.id)));
    const count = deleted.filter(Boolean).length;
    if (count > 0) this.logger.info(`Cleaned up ${count} expired agent sessions`);
    return count;
  }

  private async update(
    agentId: AgentId,
    updates: Partial<AgentSession>,
    fence: DurableExecutionFence | undefined,
    runningOnly = false,
  ): Promise<AgentSession | undefined> {
    return this.withLock(agentId, 'write', async () => {
      const session = this.read(agentId);
      if (
        !session ||
        (runningOnly && session.status !== 'running') ||
        !this.sameFence(session.executionFence, fence)
      ) {
        return undefined;
      }
      const updated = {
        ...session,
        ...updates,
        executionFence: session.executionFence,
        lastActiveAt: Date.now(),
      };
      await this.write(updated);
      return updated;
    });
  }

  private finish(
    agentId: AgentId,
    status: Exclude<AgentSessionStatus, 'running'>,
    result: NonNullable<AgentSession['result']>,
    stats?: AgentSession['stats'],
    fence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.update(
      agentId,
      { status, result, stats, completedAt: Date.now(), progress: undefined },
      fence,
    );
  }

  private read(agentId: AgentId): AgentSession | undefined {
    const file = this.file(agentId);
    if (!file) return this.cache.get(agentId);
    try {
      if (!fs.existsSync(file)) return undefined;
      const session = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentSession;
      this.cache.set(agentId, session);
      return session;
    } catch (error) {
      this.logger.warn(`Failed to load session ${agentId}:`, error);
      return undefined;
    }
  }

  private async write(session: AgentSession): Promise<void> {
    const file = this.file(session.id);
    if (!file) {
      this.cache.set(session.id, session);
      return;
    }
    try {
      const created = !fs.existsSync(file);
      await writeFileAtomic(file, JSON.stringify(session, null, 2), {
        encoding: 'utf8',
        fsync: true,
        mode: 0o600,
      });
      if (created) await syncParentDirectory(file);
      this.cache.set(session.id, session);
    } catch (error) {
      this.logger.warn(`Failed to save session ${session.id}:`, error);
      throw error;
    }
  }

  private async deleteTerminal(agentId: AgentId): Promise<boolean> {
    return this.withLock(agentId, 'write', async () => {
      const session = this.read(agentId);
      if (!session || session.status === 'running') return false;
      await this.remove(agentId);
      return true;
    });
  }

  private async remove(agentId: AgentId): Promise<void> {
    const file = this.file(agentId);
    if (file) {
      try {
        await unlink(file);
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
      }
    }
    this.cache.delete(agentId);
  }

  private withLock<T>(
    agentId: AgentId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
  ): Promise<T> {
    const file = this.file(agentId);
    if (!file) return callback();
    return withAdvisoryFileLock(
      file,
      {
        timeoutMs: LOCK_TIMEOUT_MS,
        errors: {
          prepare: (cause) => this.storageError(agentId, operation, cause),
          initialize: (cause) => this.storageError(agentId, operation, cause),
          acquire: (cause) => this.storageError(agentId, operation, cause),
          timeout: () => new Error(`Timed out acquiring agent ${operation} lock for ${agentId}`),
          release: (cause) => this.storageError(agentId, operation, cause),
        },
      },
      callback,
    );
  }

  private file(agentId: AgentId): string | undefined {
    return this.directory
      ? path.join(this.directory, `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
      : undefined;
  }

  private sorted(sessions: AgentSession[]): AgentSession[] {
    return sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }

  private storageError(agentId: AgentId, operation: string, cause: unknown): Error {
    return new Error(`Failed to ${operation} background agent session ${agentId}`, { cause });
  }

  private canReplace(
    current: DurableExecutionFence | undefined,
    next: DurableExecutionFence | undefined,
  ): boolean {
    return (
      !current ||
      (!!next && (this.sameFence(current, next) || next.fencingToken > current.fencingToken))
    );
  }

  private sameFence(
    left: DurableExecutionFence | undefined,
    right: DurableExecutionFence | undefined,
  ): boolean {
    return (
      left === right ||
      (!!left &&
        !!right &&
        left.leaseId === right.leaseId &&
        left.fencingToken === right.fencingToken)
    );
  }
}
