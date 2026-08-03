import { describe, expect, it, vi } from 'vitest';

const { createAgent } = vi.hoisted(() => ({
  createAgent: vi.fn(async (_config: unknown, _options?: unknown) => ({
    async setModel() {},
    async destroy() {},
  })),
}));

vi.mock('../session/agent.js', () => ({
  Agent: { create: createAgent },
}));

import { createSession } from '../session/legacySession.js';
import { SessionRuntime } from '../session/sessionRuntime.js';
import { SessionId } from '../local/branded.js';

/**
 * Slice #348 — the legacy Session factory + class (784L) and SessionRuntime
 * (598L) ported into the package session layer (legacySession.ts,
 * sessionRuntime.ts) — the LAST root session real files.
 *
 * Also fixed 4 package type gaps the port exposed: SessionAgentKernelStreamOptions
 * (+input/turnId/signal/includeThinking), runTaskCompleted payload
 * (+hasImages/imageCount), PromptResult (+turnsCount), and deduped the session
 * SdkMcpServerHandle to the local canonical (typed Transport/McpServer).
 */

describe('Legacy Session + SessionRuntime (package session layer)', () => {
  it('exports the session factory and runtime class', () => {
    expect(typeof createSession).toBe('function');
    expect(typeof SessionRuntime).toBe('function');
  });

  it('creates a session through the legacy factory with the mocked Agent', async () => {
    const session = await createSession({
      provider: { type: 'openai', apiKey: 'test-key' },
      model: 'gpt-5',
    });
    expect(session.sessionId).toBeDefined();
    expect(createAgent).toHaveBeenCalled();
    await session.close();
  });

  it('keeps branded session ids in the legacy session surface', () => {
    expect(SessionId('legacy-session')).toBe('legacy-session');
  });
});
