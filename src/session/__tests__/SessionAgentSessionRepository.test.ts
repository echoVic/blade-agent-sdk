import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../Session.js';
import type { AgentSessionRepository } from '../../agent/subagents/AgentSessionRepository.js';
import type { AgentSession } from '../../agent/subagents/AgentSessionStore.js';

/**
 * Storage for subagents must be injectable: a parent Session on a shared
 * repository cannot give its subagents cross-host recovery from a store rooted in
 * one host's local directory.
 */
function createRepository() {
  const sessions = new Map<string, AgentSession>();
  const repository: AgentSessionRepository = {
    saveSession: vi.fn(async (session: AgentSession) => {
      sessions.set(session.id, session);
      return true;
    }),
    loadSession: vi.fn(async (agentId) => sessions.get(agentId)),
    updateSession: vi.fn(async (agentId, updates) => {
      const current = sessions.get(agentId);
      if (!current) return undefined;
      const next = { ...current, ...updates } as AgentSession;
      sessions.set(agentId, next);
      return next;
    }),
    appendMessages: vi.fn(async (agentId, messages) => {
      const current = sessions.get(agentId);
      if (!current) return undefined;
      const next = { ...current, messages: [...current.messages, ...messages] } as AgentSession;
      sessions.set(agentId, next);
      return next;
    }),
    updateRunningSession: vi.fn(async (agentId, updates) => {
      const current = sessions.get(agentId);
      if (!current) return undefined;
      const next = { ...current, ...updates } as AgentSession;
      sessions.set(agentId, next);
      return next;
    }),
    markCompleted: vi.fn(async (agentId, result) => {
      const current = sessions.get(agentId);
      if (!current) return undefined;
      const next = { ...current, status: 'completed', result } as AgentSession;
      sessions.set(agentId, next);
      return next;
    }),
    markCancelled: vi.fn(async (agentId, result) => {
      const current = sessions.get(agentId);
      if (!current) return undefined;
      const next = {
        ...current, status: 'cancelled',
        result: result ?? { success: false as const, message: '' },
      } as AgentSession;
      sessions.set(agentId, next);
      return next;
    }),
    deleteSession: vi.fn(async (agentId) => sessions.delete(agentId)),
    listSessions: vi.fn(async () => Array.from(sessions.values())),
    listRunningSessions: vi.fn(async () =>
      Array.from(sessions.values()).filter((session) => session.status === 'running')),
    cleanupExpiredSessions: vi.fn(async () => 0),
  };
  return { repository, sessions };
}

describe('SessionOptions.agentSessionRepository', () => {
  it('uses the injected repository for subagent state', async () => {
    const { repository } = createRepository();
    const session = await createSession({
      provider: { type: 'openai', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
      agentSessionRepository: repository,
    });

    try {
      // The capability reaches the manager itself, rather than a file-backed store
      // being constructed behind the caller's back.
      const manager = (session as unknown as {
        runtime: {
          getBackgroundAgentManager(): { getSessionRepository(): AgentSessionRepository };
        };
      }).runtime.getBackgroundAgentManager();
      expect(manager.getSessionRepository()).toBe(repository);
    } finally {
      await session.close();
    }
  });
});
