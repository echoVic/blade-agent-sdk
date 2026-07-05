import { describe, expect, it, vi } from 'vitest';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type {
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
  defaultContext: {
    capabilities: {
      filesystem: {
        roots: ['/workspace'],
        cwd: '/workspace',
      },
    },
    environment: {
      BASE: '1',
    },
  },
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk package-local Session instance', () => {
  it('prepares pending turns and streams through an injected runner', async () => {
    const streamTurn = vi.fn(async function* (turn, streamOptions) {
      expect(turn.message).toBe('hello');
      expect(turn.sendOptions?.maxTurns).toBe(4);
      expect(turn.snapshot).toMatchObject({
        sessionId: 'session-1',
        context: {
          capabilities: {
            filesystem: {
              roots: ['/workspace'],
              cwd: '/tmp/project',
            },
          },
          environment: {
            BASE: '1',
            TURN: '2',
          },
        },
      });
      expect(streamOptions).toEqual({ includeThinking: true });
      yield { type: 'content', delta: 'ok', sessionId: 'session-1' } satisfies StreamMessage;
      yield {
        type: 'result',
        subtype: 'success',
        content: 'ok',
        sessionId: 'session-1',
      } satisfies StreamMessage;
    });
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn,
      createTurnId: () => 'turn-1',
    });

    await session.send('hello', {
      maxTurns: 4,
      context: {
        capabilities: {
          filesystem: {
            roots: ['/workspace'],
            cwd: '/tmp/project',
          },
        },
        environment: {
          TURN: '2',
        },
      },
    });

    await expect(collect(session.stream({ includeThinking: true }))).resolves.toEqual([
      { type: 'content', delta: 'ok', sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'ok', sessionId: 'session-1' },
    ]);
    await expect(collect(session.stream())).rejects.toThrow(
      'No pending message. Call send() before stream().',
    );
    expect(streamTurn).toHaveBeenCalledTimes(1);
  });

  it('passes session context to the injected stream runner', async () => {
    const streamTurn = vi.fn(async function* (_turn, _streamOptions, sessionContext) {
      expect(sessionContext).toEqual({
        sessionId: 'session-1',
        options,
      });
      yield {
        type: 'result',
        subtype: 'success',
        content: 'ok',
        sessionId: 'session-1',
      } satisfies StreamMessage;
    });
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn,
      createTurnId: () => 'turn-1',
    });

    await session.send('hello');
    await collect(session.stream());

    expect(streamTurn).toHaveBeenCalledTimes(1);
  });

  it('centralizes lifecycle close and abort behavior', async () => {
    const cleanup = vi.fn();
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
      cleanup,
    });

    expect(session.isClosed).toBe(false);
    await session.close();
    await session.close();

    expect(session.isClosed).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(session.send('hello')).rejects.toThrow('Session is closed');
  });
});
