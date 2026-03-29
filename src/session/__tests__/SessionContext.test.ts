import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const capturedContexts: unknown[] = [];

const createAgent = vi.fn(async () => ({
  async *streamChat(_message: string, context: unknown) {
    capturedContexts.push(context);
    yield { type: 'turn_start', turn: 1 };
    return {
      success: true,
      finalMessage: 'ok',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 0,
      },
    };
  },
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { createSession } = await import('../Session.js');

describe('Session runtime context', () => {
  it('should let turn-scoped context override the session default context', async () => {
    capturedContexts.length = 0;
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-test-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: ['/session-root'],
            cwd: '/session-root',
          },
          browser: {
            pageId: 'page-default',
          },
        },
        environment: {
          DEFAULT_ONLY: '1',
          SHARED_KEY: 'session',
        },
      },
    });

    await session.send('hello', {
      context: {
        capabilities: {
          filesystem: {
            roots: ['/turn-root'],
            cwd: '/turn-root',
          },
        },
        environment: {
          TURN_ONLY: '1',
          SHARED_KEY: 'turn',
        },
      },
    });

    for await (const _event of session.stream()) {
      // Drain the stream to completion.
    }

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          cwd: '/turn-root',
          filesystemRoots: ['/turn-root'],
          context: expect.objectContaining({
            capabilities: expect.objectContaining({
              filesystem: expect.objectContaining({
                roots: ['/turn-root'],
                cwd: '/turn-root',
              }),
              browser: expect.objectContaining({
                pageId: 'page-default',
              }),
            }),
            environment: {
              DEFAULT_ONLY: '1',
              TURN_ONLY: '1',
              SHARED_KEY: 'turn',
            },
          }),
        }),
      }),
    );

    session.close();
  });

  it('should preserve defaultContext when forking a session', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-fork-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: ['/fork-root'],
            cwd: '/fork-root',
          },
        },
      },
    });

    const forked = await session.fork();

    expect(forked.getDefaultContext()).toEqual(session.getDefaultContext());

    forked.close();
    session.close();
  });
});
