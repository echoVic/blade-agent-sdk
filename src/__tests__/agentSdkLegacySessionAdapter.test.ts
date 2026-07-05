import { describe, expect, it, vi } from 'vitest';
import { createLegacySessionRuntimeFactory } from '../../packages/agent-sdk/src/session/legacySessionAdapter.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type {
  ISession,
  SessionOptions,
  StreamMessage,
} from '../../packages/agent-sdk/src/session/types.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

function createLegacySession(sessionId: string): ISession {
  return {
    sessionId,
    messages: [],
    isClosed: false,
    send: vi.fn(async () => {}),
    stream: vi.fn(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        content: `delegated:${sessionId}`,
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
    fork: vi.fn(async () => createLegacySession(`forked:${sessionId}`)),
    getLastTrace: vi.fn(() => undefined),
    getTraces: vi.fn(() => []),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk legacy session adapter', () => {
  it('creates package-local sessions from an injected legacy module port', async () => {
    const createdLegacySession = createLegacySession('created-legacy');
    const resumedLegacySession = createLegacySession('resumed-legacy');
    const createSession = vi.fn(async () => createdLegacySession);
    const resumeSession = vi.fn(async () => resumedLegacySession);
    const loadLegacySessionModule = vi.fn(async () => ({
      createSession,
      resumeSession,
    }));
    const factory = createLegacySessionRuntimeFactory({
      loadLegacySessionModule,
      createTurnId: () => 'turn-1',
    });

    const created = await factory.create(options);
    const resumed = await factory.resume({ ...options, sessionId: 'existing-session' });

    expect(created).toBeInstanceOf(PackageLocalSession);
    expect(created.sessionId).toBe('created-legacy');
    expect(resumed).toBeInstanceOf(PackageLocalSession);
    expect(resumed.sessionId).toBe('resumed-legacy');
    expect(loadLegacySessionModule).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledWith(options);
    expect(resumeSession).toHaveBeenCalledWith({
      ...options,
      sessionId: 'existing-session',
    });

    await created.send('hello');
    expect(createdLegacySession.send).not.toHaveBeenCalled();
    await expect(collect(created.stream())).resolves.toEqual([
      {
        type: 'result',
        subtype: 'success',
        content: 'delegated:created-legacy',
        sessionId: 'created-legacy',
      },
    ]);
    expect(createdLegacySession.send).toHaveBeenCalledWith('hello', undefined);
  });
});
