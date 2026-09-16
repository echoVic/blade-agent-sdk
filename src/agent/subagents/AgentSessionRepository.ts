import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import type { AgentId } from '../../types/identifiers.js';
import type { AgentSession, AgentSessionStatus } from './AgentSessionStore.js';

export interface AgentSessionRepository {
  saveSession(session: AgentSession): Promise<boolean>;
  loadSession(agentId: AgentId): Promise<AgentSession | undefined>;
  updateSession(
    agentId: AgentId,
    updates: Partial<AgentSession>,
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
  listRunningSessions(): Promise<AgentSession[]>;
  cleanupExpiredSessions(maxAgeMs?: number): Promise<number>;
  setLogger?(logger: unknown): void;
}
