import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import type { AgentId } from '../../types/identifiers.js';
import type { AgentProgress } from '../types.js';
import type { AgentSession, AgentSessionStatus } from './AgentSessionStore.js';

/**
 * Storage capability for subagent Sessions.
 *
 * The runtime injects one of these instead of constructing a file-backed store
 * itself. A parent Session that runs on a shared repository needs its subagents to
 * survive the same way, and it cannot get that from a store rooted in one host's
 * local directory. The capability is deliberately asynchronous so a database-backed
 * implementation is possible; the default file implementation keeps its in-process
 * cache to stay fast.
 *
 * Every mutating method takes the parent's execution fence so a successor can only
 * write state it still owns.
 */
export interface AgentSessionRepository {
  saveSession(session: AgentSession): Promise<boolean>;
  loadSession(agentId: AgentId): Promise<AgentSession | undefined>;
  updateSession(
    agentId: AgentId,
    updates: Partial<AgentSession>,
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
  appendMessages(
    agentId: AgentId,
    messages: AgentSession['messages'],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
  updateRunningSession(
    agentId: AgentId,
    updates: Partial<AgentSession> & { status?: Extract<AgentSessionStatus, 'running'> },
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
  markCompleted(
    agentId: AgentId,
    result: NonNullable<AgentSession['result']>,
    stats?: AgentSession['stats'],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
  markCancelled(
    agentId: AgentId,
    result?: { success: boolean; message: string; error?: string },
    stats?: AgentSession['stats'],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
  deleteSession(agentId: AgentId, expectedExecutionFence?: DurableExecutionFence): Promise<boolean>;
  listSessions(): Promise<AgentSession[]>;
  /** Running Sessions for this process, used to restore background work at startup. */
  listRunningSessions(): Promise<AgentSession[]>;
  cleanupExpiredSessions(maxAgeMs?: number): Promise<number>;
  setLogger?(logger: unknown): void;
  clearCache?(): void;
  /** Records progress for a running subagent. */
  updateProgress?(
    agentId: AgentId,
    progress: AgentProgress,
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined>;
}
