import { describe, expect, it, vi } from 'vitest';
import {
  createSession,
  resetSessionRuntimeFactory,
  resumeSession,
} from '../../packages/agent-sdk/src/session/index.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type {
  ISession,
  SessionOptions,
  StreamMessage,
} from '../../packages/agent-sdk/src/session/types.js';
import {
  createSession as createLegacySession,
  resumeSession as resumeLegacySession,
} from '../session/Session.js';

vi.mock('../session/Session.js', () => ({
  createSession: vi.fn(async () => createLegacySessionDouble('created-legacy')),
  resumeSession: vi.fn(async () => createLegacySessionDouble('resumed-legacy')),
}));

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

function createLegacySessionDouble(sessionId: string): ISession {
  return {
    sessionId,
    messages: [],
    isClosed: false,
    send: vi.fn(async () => {}),
    stream: vi.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        content: `streamed:${sessionId}`,
        sessionId,
      } satisfies StreamMessage;
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    getDefaultContext: vi.fn(() => ({})),
    setDefaultContext: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(async () => {}),
    setMaxTurns: vi.fn(),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    mcpConnect: vi.fn(async () => {}),
    mcpDisconnect: vi.fn(async () => {}),
    mcpReconnect: vi.fn(async () => {}),
    mcpListTools: vi.fn(async () => []),
    fork: vi.fn(async () => createLegacySessionDouble(`forked:${sessionId}`)),
    getLastTrace: vi.fn(() => undefined),
    getTraces: vi.fn(() => []),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

describe('agent-sdk default session factory', () => {
  it('returns package-local kernel sessions from public create and resume lifecycles', async () => {
    resetSessionRuntimeFactory();

    const created = await createSession(options);
    const resumed = await resumeSession({ ...options, sessionId: 'existing-session' });

    expect(created).toBeInstanceOf(PackageLocalSession);
    expect(created.sessionId).not.toBe('created-legacy');
    expect(created.getDefaultContext()).toEqual({});
    expect(resumed).toBeInstanceOf(PackageLocalSession);
    expect(resumed.sessionId).toBe('existing-session');
    expect(createLegacySession).not.toHaveBeenCalled();
    expect(resumeLegacySession).not.toHaveBeenCalled();

    await created.close();
    await resumed.close();
  });
});
