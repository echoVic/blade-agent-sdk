import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import {
    InputId,
    RequestId,
    SessionId,
} from '../../types/branded.js';
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

const { createSession, resumeSession } = await import('../../node/index.js');

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

    await session.close();
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

    await forked.close();
    await session.close();
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
            modifiedInput: { userPrompt: 'updated prompt' },
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

    await session.close();
  });

  it('should forward unified tool execution updates through session.stream()', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-stream-'));
    createAgent.mockResolvedValueOnce({
      async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
        yield { type: 'turn_start', turn: 1 };
        yield {
          type: 'turn_interrupted',
          inputId: InputId('input-1'),
          requestId: RequestId('request-1'),
          turn: 1,
        };
        yield {
          type: 'input_applied',
          inputId: InputId('input-1'),
          requestId: RequestId('request-1'),
          priority: 'now',
          turn: 1,
        };
        yield {
          type: 'tool_start',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
        };
        yield {
          type: 'tool_progress',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
          progress: {
            kind: 'progress',
            message: 'loading',
          },
        };
        yield {
          type: 'tool_message',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
          content: {
            summary: 'partial output',
          },
        };
        yield {
          type: 'tool_runtime_patch',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
          patch: {
            scope: 'turn',
            source: 'tool',
            systemPromptAppend: 'extra',
          },
        };
        yield {
          type: 'tool_result',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
          result: {
            status: 'success',
            model: 'done',
            display: {
              summary: 'Read completed',
            },
          },
        };
        return {
          success: true,
          finalMessage: 'ok',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 1,
            duration: 0,
          },
        };
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });

    await session.send('hello');

    const events: string[] = [];
    let toolResultDisplay: unknown;
    for await (const event of session.stream()) {
      events.push(event.type);
      if (event.type === 'tool_result') {
        toolResultDisplay = event.display;
      }
    }

    expect(events).toEqual(expect.arrayContaining([
      'turn_interrupted',
      'input_applied',
      'tool_use',
      'tool_progress',
      'tool_message',
      'tool_runtime_patch',
      'tool_result',
    ]));
    expect(toolResultDisplay).toEqual({ summary: 'Read completed' });

    await session.close();
  });

  it('should forward turn_end events from the agent stream', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-turn-end-'));
    createAgent.mockResolvedValueOnce({
      async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
        yield { type: 'turn_start', turn: 1 };
        yield { type: 'turn_end', turn: 1, hasToolCalls: false };
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
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });

    await session.send('hello');

    const events: string[] = [];
    for await (const event of session.stream()) {
      events.push(event.type);
    }

    expect(events).toEqual(expect.arrayContaining(['turn_start', 'turn_end']));

    await session.close();
  });

  it('should continue streaming after resumeSession restores an existing session', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-resume-stream-'));
    const persistentStore = new PersistentStore(storagePath);
    const sessionId = SessionId('resumed-session');

    await persistentStore.createSession(sessionId);

    createAgent.mockResolvedValueOnce({
      async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
        yield { type: 'turn_start', turn: 1 };
        yield { type: 'turn_end', turn: 1, hasToolCalls: false };
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
    } as never);

    const session = await resumeSession({
      sessionId,
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });

    await session.send('hello again');

    const events: string[] = [];
    for await (const event of session.stream()) {
      events.push(event.type);
    }

    expect(events).toEqual(expect.arrayContaining(['turn_start', 'turn_end', 'result']));

    await session.close();
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

    await session.close();
  });

  it('allows a new request after awaited abort finishes stream cleanup', async () => {
    let requestCount = 0;
    createAgent.mockResolvedValueOnce({
      async *streamChat(
        _message: unknown,
        context: { signal?: AbortSignal },
      ): AsyncGenerator<unknown, unknown, unknown> {
        requestCount += 1;
        yield { type: 'turn_start', turn: 1 };
        if (requestCount === 1) {
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return {
          success: requestCount > 1,
          error: requestCount === 1
            ? {
                type: 'aborted',
                message: 'aborted',
              }
            : undefined,
          finalMessage: requestCount > 1 ? 'done' : undefined,
          metadata: {
            turnsCount: requestCount > 1 ? 1 : 0,
            toolCallsCount: 0,
            duration: 0,
          },
        };
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    });
    await session.send('first');

    const stream = session.stream();
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'turn_start' },
      done: false,
    });

    await session.abort();
    await expect(session.send('second')).resolves.toMatchObject({
      status: 'started',
    });

    while (!(await stream.next()).done) {
      // Drain buffered terminal events from the aborted request.
    }

    for await (const _event of session.stream()) {
      // The next request can execute independently of the buffered first stream.
    }
    await session.close();
  });

  it('can await abort from inside stream consumption without deadlocking', async () => {
    let innerClosed = false;
    createAgent.mockResolvedValueOnce({
      async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
        try {
          yield { type: 'turn_start', turn: 1 };
          return {
            success: true,
            finalMessage: 'unexpected',
            metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
          };
        } finally {
          innerClosed = true;
        }
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    });
    await session.send('abort from consumer');

    for await (const event of session.stream()) {
      if (event.type === 'turn_start') {
        await session.abort();
      }
    }

    expect(innerClosed).toBe(true);
    await session.close();
  });

  it('releases stream backpressure when an external AbortSignal fires', async () => {
    let innerClosed = false;
    createAgent.mockResolvedValueOnce({
      async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
        try {
          yield { type: 'turn_start', turn: 1 };
          return {
            success: true,
            finalMessage: 'unexpected',
            metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
          };
        } finally {
          innerClosed = true;
        }
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    });
    const controller = new AbortController();
    await session.send('external abort', { signal: controller.signal });
    const stream = session.stream();
    await stream.next();

    controller.abort();

    await vi.waitFor(() => expect(innerClosed).toBe(true));
    await session.abort();
    await expect(session.send('after external abort')).resolves.toMatchObject({
      status: 'started',
    });
    for await (const _event of stream) {
      // Drain buffered terminal output from the aborted request.
    }
    for await (const _event of session.stream()) {
      // Drain the next request.
    }
    await session.close();
  });

  it('durably queues later input and promotes it after the active request', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-queued-input-'));
    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let requestCount = 0;
    createAgent.mockResolvedValueOnce({
      async *streamChat(message: unknown): AsyncGenerator<unknown, unknown, unknown> {
        requestCount += 1;
        capturedMessages.push(message);
        yield { type: 'turn_start', turn: 1 };
        if (requestCount === 1) {
          await firstRequestGate;
        }
        return {
          success: true,
          finalMessage: `done-${requestCount}`,
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 0,
          },
        };
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });
    const started = await session.send('first');
    expect(started.status).toBe('started');

    const firstStream = session.stream();
    await firstStream.next();
    const queued = await session.send('second', {
      priority: 'later',
      expectedRequestId:
        started.status === 'started' ? started.requestId : undefined,
    });
    expect(queued).toMatchObject({
      status: 'queued',
      priority: 'later',
    });

    releaseFirstRequest();
    while (!(await firstStream.next()).done) {
      // Drain the first request.
    }

    for await (const _event of session.stream()) {
      // The durable follow-up was promoted to the next request.
    }

    expect(capturedMessages.slice(-2)).toEqual(['first', 'second']);

    await session.close();
  });

  it('restores unresolved durable input as the next pending request', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-context-recovered-input-'));
    const sessionId = SessionId('session-recovered-input');
    const persistentStore = new PersistentStore(storagePath);
    await persistentStore.saveInputEnqueued(sessionId, {
      inputId: InputId('input-recovered'),
      content: 'continue after restart',
      priority: 'next',
      acceptedAt: 1,
    });

    const session = await resumeSession({
      sessionId,
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
    });

    for await (const _event of session.stream()) {
      // Restored input is immediately available without another send().
    }

    expect(capturedMessages.at(-1)).toBe('continue after restart');
    await session.close();
  });

  it('routes now-priority input to the active step controller', async () => {
    let observedStepSignal: AbortSignal | undefined;
    createAgent.mockResolvedValueOnce({
      async *streamChat(
        _message: unknown,
        _context: unknown,
        options: {
          runControl?: {
            stepSignal: AbortSignal;
          };
        },
      ): AsyncGenerator<unknown, unknown, unknown> {
        observedStepSignal = options.runControl?.stepSignal;
        yield { type: 'turn_start', turn: 1 };
        await new Promise<void>((resolve) => {
          if (observedStepSignal?.aborted) {
            resolve();
            return;
          }
          observedStepSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return {
          success: false,
          error: {
            type: 'aborted',
            message: 'interrupted',
          },
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 0,
          },
        };
      },
      async setModel() {},
    } as never);

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    });
    const started = await session.send('first');
    const stream = session.stream();
    await stream.next();

    const steered = await session.send('change direction now', {
      priority: 'now',
      expectedRequestId:
        started.status === 'started' ? started.requestId : undefined,
    });

    expect(steered).toMatchObject({
      status: 'steered',
      priority: 'now',
    });
    expect(observedStepSignal?.aborted).toBe(true);
    expect(observedStepSignal?.reason).toMatchObject({
      kind: 'steering',
      inputId: steered.inputId,
    });

    while (!(await stream.next()).done) {
      // Drain the interrupted request.
    }
    await session.close();
  });

  it('rejects steering targeted at a stale request id', async () => {
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    });
    const started = await session.send('first');
    expect(started.status).toBe('started');

    await expect(session.send('stale steering', {
      priority: 'next',
      expectedRequestId: RequestId('stale-request'),
    })).rejects.toMatchObject({
      code: 'SESSION_REQUEST_MISMATCH',
    });

    await session.close();
  });
});
