import { describe, expect, it } from 'vitest';
import { Agent } from '../session/agent.js';
import { BackgroundAgentManager } from '../session/backgroundAgentManager.js';
import { SessionId } from '../local/branded.js';
import { NOOP_LOGGER } from '../local/Logger.js';
import { AgentSessionStore } from '../local/agentSessionStore.js';

/**
 * Slice #347 — the session Agent + BackgroundAgentManager ported into the
 * package session layer (session/agent.ts, session/backgroundAgentManager.ts).
 *
 * The last root agent-core real files: root src/agent/Agent.ts (662L) and
 * src/agent/subagents/BackgroundAgentManager.ts (605L) are now re-export
 * shims of @blade-ai/agent-sdk/session/internal.
 */

describe('Agent + BackgroundAgentManager (package session layer)', () => {
  it('exports the Agent class and runtime deps contract', () => {
    expect(typeof Agent).toBe('function');
  });

  it('creates a background agent manager with a real session store', () => {
    const store = AgentSessionStore.create();
    const manager = BackgroundAgentManager.create(NOOP_LOGGER, store);
    expect(manager).toBeInstanceOf(BackgroundAgentManager);
    manager.killAll();
  });

  it('starts background agents and returns branded ids', () => {
    const store = AgentSessionStore.create();
    const manager = BackgroundAgentManager.create(NOOP_LOGGER, store);
    const id = manager.startBackgroundAgent({
      config: { name: 'general-purpose', description: 'generic' } as never,
      bladeConfig: { models: [] } as never,
      description: 'background task',
      prompt: 'do something',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    manager.killAll();
    expect(SessionId('bg-session')).toBe('bg-session');
  });
});
