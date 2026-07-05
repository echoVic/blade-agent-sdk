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

const legacySessionDoubles: ISession[] = [];

function createLegacySessionDouble(sessionId: string): ISession {
  const session = {
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
  legacySessionDoubles.push(session);
  return session;
}

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk default session factory', () => {
  it('returns package-local carriers from public create and resume lifecycles', async () => {
    legacySessionDoubles.length = 0;
    resetSessionRuntimeFactory();

    const created = await createSession(options);
    const resumed = await resumeSession({ ...options, sessionId: 'existing-session' });

    expect(created).toBeInstanceOf(PackageLocalSession);
    expect(created.sessionId).toBe('created-legacy');
    expect(resumed).toBeInstanceOf(PackageLocalSession);
    expect(resumed.sessionId).toBe('resumed-legacy');
    expect(createLegacySession).toHaveBeenCalledWith(options);
    expect(resumeLegacySession).toHaveBeenCalledWith({
      ...options,
      sessionId: 'existing-session',
    });

    await created.send('hello');
    expect(legacySessionDoubles[0]?.send).not.toHaveBeenCalled();
    await expect(collect(created.stream())).resolves.toEqual([
      {
        type: 'result',
        subtype: 'success',
        content: 'streamed:created-legacy',
        sessionId: 'created-legacy',
      },
    ]);
    expect(legacySessionDoubles[0]?.send).toHaveBeenCalledWith('hello', undefined);
  });
});
