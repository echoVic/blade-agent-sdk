import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JSONLStore } from '../../context/storage/JSONLStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import type { SessionEvent } from '../../context/types.js';
import { HookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import { SessionId } from '../../types/branded.js';
import { HookEvent } from '../../types/constants.js';

// 每个用例可覆盖的 streamChat 实现；默认产出一条成功事件。
type StreamChatImpl = (
  message: unknown,
  context: unknown,
) => AsyncGenerator<unknown, unknown, unknown>;

let streamChatImpl: StreamChatImpl = async function* defaultStream() {
  yield { type: 'turn_start', turn: 1 };
  return {
    success: true,
    finalMessage: 'ok',
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
  };
};

const createAgent = vi.fn(async () => ({
  streamChat: (message: unknown, context: unknown) =>
    streamChatImpl(message, context),
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: { create: createAgent },
}));

const { createSession } = await import('../../node/index.js');

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-steering-resilience-'));
}

function baseOptions(storagePath: string) {
  return {
    provider: { type: 'openai-compatible' as const, apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    storagePath,
  };
}

async function readEvents(
  storagePath: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const filePath = getSessionFilePathFromStorageRoot(
    storagePath,
    SessionId(sessionId),
  );
  return new JSONLStore(filePath).readAll();
}

describe('Session steering resilience', () => {
  it('releases the request when a UserPromptSubmit hook throws so a new request can start', async () => {
    streamChatImpl = async function* defaultStream() {
      yield { type: 'turn_start', turn: 1 };
      return {
        success: true,
        finalMessage: 'ok',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    };
    const storagePath = createWorkspaceRoot();
    let shouldThrow = true;
    const session = await createSession({
      ...baseOptions(storagePath),
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async () => {
            if (shouldThrow) {
              throw new Error('hook boom');
            }
            return { action: 'continue' };
          },
        ],
      },
    });

    const first = await session.send('first');
    expect(first.status).toBe('started');

    const events: string[] = [];
    for await (const event of session.stream()) {
      if (event.type === 'error') {
        events.push(event.message);
      }
    }
    expect(events).toContain('hook boom');

    // 关键断言：hook 失败后会话必须回到可接受新请求的状态，而不是永久 running。
    expect(session.getPendingInputs()).toHaveLength(0);
    shouldThrow = false;
    const second = await session.send('second');
    expect(second.status).toBe('started');

    for await (const _event of session.stream()) {
      // drain
    }

    await session.close();
  });

  it('propagates request cancellation into the initial UserPromptSubmit hook', async () => {
    const storagePath = createWorkspaceRoot();
    const started = Promise.withResolvers<void>();
    const cancellation = new Error('cancel hook wait');
    let hookSignal: AbortSignal | undefined;
    const session = await createSession({
      ...baseOptions(storagePath),
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async (input) => {
            hookSignal = input.abortSignal;
            started.resolve();
            await new Promise<void>((_resolve, reject) => {
              input.abortSignal?.addEventListener(
                'abort',
                () => reject(input.abortSignal?.reason),
                { once: true },
              );
            });
            return { action: 'continue' };
          },
        ],
      },
    });
    const controller = new AbortController();
    await session.send('cancel during hook', { signal: controller.signal });
    const stream = session.stream();
    const firstEvent = stream.next();

    await started.promise;
    controller.abort(cancellation);

    await expect(firstEvent).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(hookSignal?.aborted).toBe(true);
    expect(hookSignal?.reason).toEqual({
      kind: 'external_abort',
      cause: cancellation,
    });

    for await (const _event of stream) {
      // drain
    }
    await session.close();
  });

  it('does not hide a containment failure behind request cancellation', async () => {
    const started = Promise.withResolvers<void>();
    const containmentError = new HookProcessContainmentError(
      'Hook process cleanup failed',
    );
    streamChatImpl = async function* containmentFailureStream(
      _message,
      context,
    ) {
      const signal = (context as { signal: AbortSignal }).signal;
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield* [] as never[];
      throw containmentError;
    };
    const session = await createSession(baseOptions(createWorkspaceRoot()));
    const controller = new AbortController();
    await session.send('cancel during cleanup', { signal: controller.signal });
    const stream = session.stream();
    const firstEvent = stream.next();
    const rejection = expect(firstEvent).rejects.toBe(containmentError);

    await started.promise;
    controller.abort(new Error('request cancelled'));

    await rejection;
    await session.close();
  });

  it('closes cleanly when the consumer pauses on a setup-hook error', async () => {
    const session = await createSession({
      ...baseOptions(createWorkspaceRoot()),
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async () => {
            throw new Error('hook close');
          },
        ],
      },
    });
    await session.send('fail before agent stream');
    const output = session.stream();
    await expect(output.next()).resolves.toMatchObject({
      value: { type: 'error', message: 'hook close' },
      done: false,
    });

    await session.close();

    expect(session.isClosed).toBe(true);
    await expect(output.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('does not double-apply the initial input when the stream throws before the first event', async () => {
    streamChatImpl = async function* throwingStream() {
      // 在产出任何事件之前抛错，模拟 input_applied 已持久化但流随即失败。
      // 先 yield 让其成为合法的 async generator，再在首次拉取时抛出。
      if (Date.now() >= 0) {
        throw new Error('stream boom');
      }
      yield { type: 'turn_start', turn: 1 };
    };
    const storagePath = createWorkspaceRoot();
    const session = await createSession(baseOptions(storagePath));
    const sessionId = session.sessionId;

    await session.send('only once');
    for await (const _event of session.stream()) {
      // drain to completion / error
    }

    // 失败请求收尾后不应把初始输入重新排队。
    expect(session.getPendingInputs()).toHaveLength(0);

    const events = await readEvents(storagePath, sessionId);
    const appliedForInput = events.filter(
      (event) => event.type === 'input_applied',
    );
    // 同一初始输入至多写入一次 input_applied，绝不能重复。
    expect(appliedForInput.length).toBeLessThanOrEqual(1);

    await session.close();
  });

  it('finishes a pending request when abort() is called before stream()', async () => {
    streamChatImpl = async function* defaultStream() {
      yield { type: 'turn_start', turn: 1 };
      return {
        success: true,
        finalMessage: 'ok',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    };
    const storagePath = createWorkspaceRoot();
    const session = await createSession(baseOptions(storagePath));

    const submission = await session.send('pending then abort');
    expect(submission.status).toBe('started');

    // send() 已返回、stream() 尚未调用时中止：不应被静默忽略。
    await session.abort();

    // 中止后会话回到 idle，可以启动全新请求。
    const next = await session.send('after abort');
    expect(next.status).toBe('started');

    for await (const _event of session.stream()) {
      // drain
    }

    await session.close();
  });
});
