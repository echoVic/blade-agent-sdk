import { describe, expect, it, vi } from 'vitest';
import type { AgentTrace } from '../../packages/agent-sdk/src/observability/types.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type {
  ISession,
  SessionOptions,
  StreamMessage,
} from '../../packages/agent-sdk/src/session/types.js';
import { PermissionMode } from '../../packages/agent-sdk/src/types/common.js';

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

  it('owns basic control state without requiring a delegate', async () => {
    const streamTurn = vi.fn(async function* (turn, _streamOptions, sessionContext) {
      expect(turn.sendOptions?.maxTurns).toBeUndefined();
      expect(sessionContext?.options).toMatchObject({
        model: 'model-2',
        permissionMode: PermissionMode.YOLO,
        maxTurns: 3,
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

    session.setPermissionMode(PermissionMode.YOLO);
    await session.setModel('model-2');
    session.setMaxTurns(3);

    await expect(session.supportedModels()).resolves.toEqual([
      {
        id: 'default',
        name: 'model-2',
        provider: 'openai-compatible',
      },
    ]);
    await session.send('hello');
    await collect(session.stream());

    expect(streamTurn).toHaveBeenCalledTimes(1);
  });

  it('fails MCP actions with a clear runtime capability error when no MCP runtime is configured', async () => {
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
    });

    await expect(session.mcpConnect('server-1')).rejects.toThrow(
      'MCP runtime is not configured for this session.',
    );
    await expect(session.mcpDisconnect('server-1')).rejects.toThrow(
      'MCP runtime is not configured for this session.',
    );
    await expect(session.mcpReconnect('server-1')).rejects.toThrow(
      'MCP runtime is not configured for this session.',
    );
  });

  it('routes fork through a package-local runtime port without requiring a delegate', async () => {
    const forked = { sessionId: 'forked-session' } as ISession;
    const fork = vi.fn(async () => forked);
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
      runtime: { fork },
    });

    await expect(session.fork({ messageId: 'message-1' })).resolves.toBe(forked);
    expect(fork).toHaveBeenCalledWith({ messageId: 'message-1' });
  });

  it('fails fork with a clear runtime capability error when no fork runtime is configured', async () => {
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
    });

    await expect(session.fork({ messageId: 'message-1' })).rejects.toThrow(
      'Fork runtime is not configured for this session.',
    );
  });

  it('reads traces from a package-local runtime port without requiring a delegate', () => {
    const trace: AgentTrace = {
      id: 'trace-1',
      sessionId: 'session-1',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      events: [],
      spans: [],
    };
    const getLastTrace = vi.fn(() => trace);
    const getTraces = vi.fn(() => [trace]);
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
      runtime: { getLastTrace, getTraces },
    });

    expect(session.getLastTrace()).toBe(trace);
    expect(session.getTraces()).toEqual([trace]);
    expect(getLastTrace).toHaveBeenCalledTimes(1);
    expect(getTraces).toHaveBeenCalledTimes(1);
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

  it('delegates the not-yet-migrated compatibility surface when a delegate is provided', async () => {
    const forked = { sessionId: 'forked-session' } as ISession;
    const trace: AgentTrace = {
      id: 'trace-1',
      sessionId: 'session-1',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      events: [],
      spans: [],
    };
    const delegate = {
      messages: [{ role: 'assistant' as const, content: 'delegated' }],
      isClosed: false,
      close: vi.fn(async () => {}),
      abort: vi.fn(),
      getDefaultContext: vi.fn(() => ({ environment: { DELEGATED: '1' } })),
      setDefaultContext: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(async () => {}),
      setMaxTurns: vi.fn(),
      supportedModels: vi.fn(async () => [
        { id: 'model-1', name: 'model-1', provider: 'openai-compatible' },
      ]),
      mcpServerStatus: vi.fn(async () => [
        { name: 'server-1', status: 'connected' as const, toolCount: 1 },
      ]),
      mcpConnect: vi.fn(async () => {}),
      mcpDisconnect: vi.fn(async () => {}),
      mcpReconnect: vi.fn(async () => {}),
      mcpListTools: vi.fn(async () => [
        { name: 'tool-1', description: 'Tool one', serverName: 'server-1' },
      ]),
      fork: vi.fn(async () => forked),
      getLastTrace: vi.fn(() => trace),
      getTraces: vi.fn(() => [trace]),
    };
    const cleanup = vi.fn();
    const session = new PackageLocalSession({
      sessionId: 'session-1',
      options,
      streamTurn: async function* () {},
      createTurnId: () => 'turn-1',
      cleanup,
      delegate,
    });
    const nextContext = { environment: { NEXT: '1' } };

    expect(session.messages).toEqual(delegate.messages);
    expect(session.getDefaultContext()).toEqual({ environment: { DELEGATED: '1' } });
    session.setDefaultContext(nextContext);
    session.setPermissionMode(PermissionMode.YOLO);
    await session.setModel('model-2');
    session.setMaxTurns(12);

    await expect(session.supportedModels()).resolves.toEqual([
      { id: 'model-1', name: 'model-1', provider: 'openai-compatible' },
    ]);
    await expect(session.mcpServerStatus()).resolves.toEqual([
      { name: 'server-1', status: 'connected', toolCount: 1 },
    ]);
    await session.mcpConnect('server-1');
    await session.mcpDisconnect('server-1');
    await session.mcpReconnect('server-1');
    await expect(session.mcpListTools()).resolves.toEqual([
      { name: 'tool-1', description: 'Tool one', serverName: 'server-1' },
    ]);
    await expect(session.fork({ messageId: 'message-1' })).resolves.toBe(forked);
    expect(session.getLastTrace()).toBe(trace);
    expect(session.getTraces()).toEqual([trace]);
    session.abort();
    await session.close();

    expect(delegate.setDefaultContext).toHaveBeenCalledWith(nextContext);
    expect(delegate.setPermissionMode).toHaveBeenCalledWith(PermissionMode.YOLO);
    expect(delegate.setModel).toHaveBeenCalledWith('model-2');
    expect(delegate.setMaxTurns).toHaveBeenCalledWith(12);
    expect(delegate.mcpConnect).toHaveBeenCalledWith('server-1');
    expect(delegate.mcpDisconnect).toHaveBeenCalledWith('server-1');
    expect(delegate.mcpReconnect).toHaveBeenCalledWith('server-1');
    expect(delegate.fork).toHaveBeenCalledWith({ messageId: 'message-1' });
    expect(delegate.abort).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(delegate.close).toHaveBeenCalledTimes(1);
  });
});
