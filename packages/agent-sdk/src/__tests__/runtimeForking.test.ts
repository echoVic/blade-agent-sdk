import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeForkingModulePath = '../session/runtimeForking.js';
const runtimeForkingSourcePath = 'src/session/runtimeForking.ts';

describe('agent-sdk package-local runtime fork helpers', () => {
  it('materializes fork state and creates child sessions without runtime state', async () => {
    expect(existsSync(runtimeForkingSourcePath)).toBe(true);

    const { forkPackageLocalRuntimeSession } = await import(runtimeForkingModulePath);
    const snapshot = {
      id: 'session-1',
      messages: [],
      metadata: {},
    };
    const calls: unknown[] = [];
    const childSession = { id: 'fork-1' };
    const options = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      },
      model: 'test-model',
    };

    await expect(
      forkPackageLocalRuntimeSession({
        sessionId: 'session-1',
        options,
        forkOptions: {
          messageId: 'message-1',
        },
        sessionStore: {
          async forkState(sessionId: string, forkOptions: unknown) {
            calls.push(['forkState', sessionId, forkOptions]);
            return snapshot;
          },
          async writeForkState(forkedSessionId: string, forkedSnapshot: unknown) {
            calls.push(['writeForkState', forkedSessionId, forkedSnapshot]);
            return forkedSnapshot;
          },
        },
        createForkSessionId() {
          calls.push(['createForkSessionId']);
          return 'fork-1';
        },
        createForkSession(sessionId: string, forkedOptions: unknown) {
          calls.push(['createForkSession', sessionId, forkedOptions]);
          return childSession;
        },
      }),
    ).resolves.toBe(childSession);

    expect(calls).toEqual([
      ['forkState', 'session-1', { messageId: 'message-1' }],
      ['createForkSessionId'],
      ['writeForkState', 'fork-1', snapshot],
      ['createForkSession', 'fork-1', options],
    ]);
  });

  it('reports fork capability and materialization failures clearly', async () => {
    expect(existsSync(runtimeForkingSourcePath)).toBe(true);

    const { forkPackageLocalRuntimeSession } = await import(runtimeForkingModulePath);
    const options = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      },
      model: 'test-model',
    };

    await expect(
      forkPackageLocalRuntimeSession({
        sessionId: 'session-1',
        options,
        sessionStore: {
          async forkState() {
            throw new Error('should not fork');
          },
          async writeForkState() {
            throw new Error('should not write');
          },
        },
      }),
    ).rejects.toThrow('Fork runtime is not configured for this session.');

    await expect(
      forkPackageLocalRuntimeSession({
        sessionId: 'missing-session',
        options,
        sessionStore: {
          async forkState() {
            return null;
          },
          async writeForkState() {
            throw new Error('should not write');
          },
        },
        createForkSessionId: () => 'fork-1',
        createForkSession: () => ({ id: 'fork-1' }),
      }),
    ).rejects.toThrow('Session "missing-session" was not found for fork.');

    await expect(
      forkPackageLocalRuntimeSession({
        sessionId: 'session-1',
        options,
        sessionStore: {
          async forkState() {
            return {
              id: 'session-1',
              messages: [],
              metadata: {},
            };
          },
          async writeForkState() {
            return null;
          },
        },
        createForkSessionId: () => 'fork-1',
        createForkSession: () => ({ id: 'fork-1' }),
      }),
    ).rejects.toThrow('Session "session-1" could not be materialized for fork.');
  });

  it('creates fork operations that preserve fork callbacks without runtime state', async () => {
    const { createPackageLocalRuntimeForkOperations } = await import(runtimeForkingModulePath);
    const snapshot = {
      id: 'session-1',
      messages: [],
      metadata: {},
    };
    const childSession = { id: 'fork-ops' };
    const options = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      },
      model: 'test-model',
    };
    const calls: unknown[] = [];

    const operations = createPackageLocalRuntimeForkOperations({
      sessionId: 'session-1',
      options,
      sessionStore: {
        async forkState(sessionId: string, forkOptions: unknown) {
          calls.push(['forkState', sessionId, forkOptions]);
          return snapshot;
        },
        async writeForkState(forkedSessionId: string, forkedSnapshot: unknown) {
          calls.push(['writeForkState', forkedSessionId, forkedSnapshot]);
          return forkedSnapshot;
        },
      },
      createForkSessionId() {
        calls.push(['createForkSessionId']);
        return 'fork-ops';
      },
      createForkSession(sessionId: string, forkedOptions: unknown) {
        calls.push(['createForkSession', sessionId, forkedOptions]);
        return childSession;
      },
    });

    await expect(
      operations.fork({
        messageId: 'message-ops',
      }),
    ).resolves.toBe(childSession);
    expect(calls).toEqual([
      ['forkState', 'session-1', { messageId: 'message-ops' }],
      ['createForkSessionId'],
      ['writeForkState', 'fork-ops', snapshot],
      ['createForkSession', 'fork-ops', options],
    ]);
  });
});
