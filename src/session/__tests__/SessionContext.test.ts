import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import { HookEvent } from '../../types/constants.js';

const capturedContexts: unknown[] = [];
const capturedMessages: unknown[] = [];

const createAgent = vi.fn(async () => ({
  async *streamChat(message: unknown, context: unknown) {
    capturedMessages.push(message);
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
    capturedMessages.length = 0;
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

  it('should preserve image parts when UserPromptSubmit hooks rewrite multimodal text', async () => {
    capturedContexts.length = 0;
    capturedMessages.length = 0;
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-hook-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async () => ({
            action: 'continue',
            modifiedInput: 'updated prompt',
          }),
        ],
      },
    });

    await session.send([
      { type: 'text', text: 'original prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,hook' } },
    ] satisfies ContentPart[]);

    for await (const _event of session.stream()) {
      // Drain the stream to completion.
    }

    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]).toEqual([
      { type: 'text', text: 'updated prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,hook' } },
    ]);

    session.close();
  });

  it('fails with a controlled runtime error instead of a non-null assertion crash', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-runtime-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });

    await session.send('hello');

    const brokenSession = session as unknown as {
      runtime: null;
      initialized: boolean;
      stream: typeof session.stream;
      close: typeof session.close;
    };
    brokenSession.runtime = null;
    brokenSession.initialized = true;

    await expect(async () => {
      for await (const _event of brokenSession.stream()) {
        // Drain stream.
      }
    }).rejects.toThrow('Session runtime is not initialized');

    session.close();
  });
});
