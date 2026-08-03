import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../local/branded.js';
import { createPackageLocalSessionRuntimeFactory } from '../session/packageLocalRuntimeFactory.js';
import { PackageLocalSession } from '../session/sessionInstance.js';
import type {
  ISession,
  SessionOptions,
  StreamMessage,
} from '../session/types.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk package-local runtime factory', () => {
  it('creates package-local sessions with generated ids and injected stream runners', async () => {
    const cleanup = vi.fn();
    const createStreamTurn = vi.fn((context) => {
      expect(context).toMatchObject({
        sessionId: SessionId('session-created'),
        options,
        isResume: false,
      });
      return async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          content: 'created',
          sessionId: SessionId('session-created'),
        } satisfies StreamMessage;
      };
    });
    const factory = createPackageLocalSessionRuntimeFactory({
      createSessionId: () => SessionId('session-created'),
      createTurnId: () => 'turn-created',
      createStreamTurn,
      cleanup,
    });

    const session = await factory.create(options);

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-created');
    await session.send('hello');
    await expect(collect(session.stream())).resolves.toEqual([
      {
        type: 'result',
        subtype: 'success',
        content: 'created',
        sessionId: SessionId('session-created'),
      },
    ]);
    await session.close();
    expect(cleanup).toHaveBeenCalledWith({
      sessionId: SessionId('session-created'),
      options,
      isResume: false,
    });
  });

  it('resumes package-local sessions with the supplied session id', async () => {
    const factory = createPackageLocalSessionRuntimeFactory({
      createSessionId: () => {
        throw new Error('createSessionId should not be used for resume');
      },
      createTurnId: () => 'turn-resumed',
      createStreamTurn: vi.fn((context) => {
        expect(context).toMatchObject({
          sessionId: SessionId('session-resumed'),
          isResume: true,
        });
        return async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            content: 'resumed',
            sessionId: SessionId('session-resumed'),
          } satisfies StreamMessage;
        };
      }),
    });

    const session = await factory.resume({ ...options, sessionId: SessionId('session-resumed') });

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('session-resumed');
    await session.send('hello');
    await expect(collect(session.stream())).resolves.toMatchObject([
      {
        type: 'result',
        content: 'resumed',
        sessionId: SessionId('session-resumed'),
      },
    ]);
  });

  it('wires package-local runtime ports into created sessions', async () => {
    const forked = { sessionId: SessionId('forked-session') } as ISession;
    const fork = vi.fn(async () => forked);
    const createSessionRuntimePort = vi.fn((context) => {
      expect(context).toMatchObject({
        sessionId: SessionId('session-created'),
        isResume: false,
      });
      return { fork };
    });
    const factory = createPackageLocalSessionRuntimeFactory({
      createSessionId: () => SessionId('session-created'),
      createTurnId: () => 'turn-created',
      createStreamTurn: () => async function* () {},
      createSessionRuntimePort,
    });

    const session = await factory.create(options);

    await expect(session.fork({ messageId: 'message-1' })).resolves.toBe(forked);
    expect(createSessionRuntimePort).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith({ messageId: 'message-1' });
  });

  it.each([
    ['create', 'session-created'],
    ['resume', 'session-resumed'],
  ] as const)('cleans up resources when %s initialization fails', async (operation, sessionId) => {
    const cleanup = vi.fn(async () => {});
    const factory = createPackageLocalSessionRuntimeFactory({
      createSessionId: () => SessionId('session-created'),
      createTurnId: () => 'turn-created',
      createStreamTurn: () => async function* () {},
      async initialize() {
        throw new Error('initialization failed');
      },
      cleanup,
    });

    const result = operation === 'create'
      ? factory.create(options)
      : factory.resume({ ...options, sessionId: SessionId(sessionId) });

    await expect(result).rejects.toThrow('initialization failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith({
      sessionId,
      options,
      isResume: operation === 'resume',
    });
  });
});
