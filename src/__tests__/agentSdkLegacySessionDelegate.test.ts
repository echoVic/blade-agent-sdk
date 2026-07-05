import { describe, expect, it, vi } from 'vitest';
import { createLegacyDelegateSession } from '../../packages/agent-sdk/src/session/legacySessionDelegate.js';
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
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function createLegacySession(): ISession {
  return {
    sessionId: 'legacy-session',
    messages: [{ role: 'assistant', content: 'from legacy' }],
    isClosed: false,
    send: vi.fn(async () => {}),
    stream: vi.fn(async function* (streamOptions) {
      expect(streamOptions).toEqual({ includeThinking: true });
      yield {
        type: 'content',
        delta: 'delegated',
        sessionId: 'legacy-session',
      } satisfies StreamMessage;
      yield {
        type: 'result',
        subtype: 'success',
        content: 'delegated',
        sessionId: 'legacy-session',
      } satisfies StreamMessage;
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    getDefaultContext: vi.fn(() => ({ environment: { LEGACY: '1' } })),
    setDefaultContext: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(async () => {}),
    setMaxTurns: vi.fn(),
    supportedModels: vi.fn(async () => [
      { id: 'legacy-model', name: 'legacy-model', provider: 'openai-compatible' },
    ]),
    mcpServerStatus: vi.fn(async () => [
      { name: 'legacy-mcp', status: 'connected' as const, toolCount: 1 },
    ]),
    mcpConnect: vi.fn(async () => {}),
    mcpDisconnect: vi.fn(async () => {}),
    mcpReconnect: vi.fn(async () => {}),
    mcpListTools: vi.fn(async () => [
      { name: 'legacy-tool', description: 'Legacy tool', serverName: 'legacy-mcp' },
    ]),
    fork: vi.fn(async () => createLegacySession()),
    getLastTrace: vi.fn(() => undefined),
    getTraces: vi.fn(() => []),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

describe('agent-sdk legacy session delegate wrapper', () => {
  it('wraps a legacy session in a package-local session carrier', async () => {
    const legacySession = createLegacySession();
    const wrapped = createLegacyDelegateSession({
      delegate: legacySession,
      options,
      createTurnId: () => 'turn-1',
    });

    expect(wrapped).toBeInstanceOf(PackageLocalSession);
    expect(wrapped.sessionId).toBe('legacy-session');
    expect(wrapped.messages).toEqual([{ role: 'assistant', content: 'from legacy' }]);
    expect(wrapped.getDefaultContext()).toEqual({ environment: { LEGACY: '1' } });
    await expect(wrapped.supportedModels()).resolves.toEqual([
      { id: 'legacy-model', name: 'legacy-model', provider: 'openai-compatible' },
    ]);

    await wrapped.send('hello', {
      maxTurns: 3,
      context: { environment: { TURN: '1' } },
    });

    expect(legacySession.send).not.toHaveBeenCalled();
    await expect(collect(wrapped.stream({ includeThinking: true }))).resolves.toEqual([
      { type: 'content', delta: 'delegated', sessionId: 'legacy-session' },
      {
        type: 'result',
        subtype: 'success',
        content: 'delegated',
        sessionId: 'legacy-session',
      },
    ]);
    expect(legacySession.send).toHaveBeenCalledWith('hello', {
      maxTurns: 3,
      context: { environment: { TURN: '1' } },
    });
    expect(legacySession.stream).toHaveBeenCalledWith({ includeThinking: true });

    wrapped.setPermissionMode(PermissionMode.YOLO);
    await wrapped.setModel('next-model');
    wrapped.setMaxTurns(8);
    await wrapped.mcpConnect('legacy-mcp');
    await wrapped.mcpDisconnect('legacy-mcp');
    await wrapped.mcpReconnect('legacy-mcp');
    await expect(wrapped.mcpListTools()).resolves.toEqual([
      { name: 'legacy-tool', description: 'Legacy tool', serverName: 'legacy-mcp' },
    ]);
    wrapped.abort();
    await wrapped.close();
    await wrapped.close();

    expect(legacySession.setPermissionMode).toHaveBeenCalledWith(PermissionMode.YOLO);
    expect(legacySession.setModel).toHaveBeenCalledWith('next-model');
    expect(legacySession.setMaxTurns).toHaveBeenCalledWith(8);
    expect(legacySession.mcpConnect).toHaveBeenCalledWith('legacy-mcp');
    expect(legacySession.mcpDisconnect).toHaveBeenCalledWith('legacy-mcp');
    expect(legacySession.mcpReconnect).toHaveBeenCalledWith('legacy-mcp');
    expect(legacySession.abort).toHaveBeenCalledTimes(1);
    expect(legacySession.close).toHaveBeenCalledTimes(1);
  });
});
