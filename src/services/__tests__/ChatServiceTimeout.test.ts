import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { ModelTimeoutError } from '../../errors/ModelTimeoutError.js';
import type {
  ChatConfig,
  IChatService,
} from '../ChatServiceInterface.js';
import { wrapChatServiceWithTimeouts } from '../ChatServiceTimeout.js';

function createService(
  overrides: Partial<IChatService> = {},
  configOverrides: Partial<ChatConfig> = {},
): IChatService {
  let config: ChatConfig = {
    provider: 'openai-compatible',
    apiKey: 'test',
    baseUrl: 'https://example.test',
    model: 'test-model',
    ...configOverrides,
  };

  return {
    async chat() {
      return { content: 'chat' };
    },
    async sideQuery() {
      return { content: 'side' };
    },
    async *streamChat() {
      yield { content: 'stream' };
    },
    getConfig() {
      return config;
    },
    updateConfig(next) {
      config = { ...config, ...next };
    },
    ...overrides,
  };
}

describe('wrapChatServiceWithTimeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a stalled non-streaming request with a typed timeout', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const callerController = new AbortController();
    const service = createService(
      {
        chat: vi.fn(async (_messages, _tools, signal) => {
          providerSignal = signal;
          return await new Promise<never>(() => {});
        }),
      },
      { requestTimeoutMs: 50 },
    );
    const wrapped = wrapChatServiceWithTimeouts(service);
    const result = wrapped.chat([], undefined, callerController.signal);
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ModelTimeoutError',
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBeInstanceOf(ModelTimeoutError);
    expect(callerController.signal.aborted).toBe(false);
  });

  it('aborts a stream that produces no next chunk before the idle deadline', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const service = createService(
      {
        async *streamChat(_messages, _tools, signal) {
          providerSignal = signal;
          await new Promise(() => {});
        },
      },
      { streamIdleTimeoutMs: 75 },
    );
    const stream = wrapChatServiceWithTimeouts(service).streamChat([]);
    const next = stream.next();
    const rejection = expect(next).rejects.toMatchObject({
      name: 'ModelTimeoutError',
      code: 'MODEL_STREAM_IDLE_TIMEOUT',
      timeoutMs: 75,
    });

    await vi.advanceTimersByTimeAsync(75);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBeInstanceOf(ModelTimeoutError);
  });

  it('does not count consumer backpressure as stream idle time', async () => {
    vi.useFakeTimers();
    const service = createService(
      {
        async *streamChat() {
          yield { content: 'first' };
          await new Promise(() => {});
        },
      },
      { streamIdleTimeoutMs: 50 },
    );
    const stream = wrapChatServiceWithTimeouts(service).streamChat([]);

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { content: 'first' },
    });
    await vi.advanceTimersByTimeAsync(500);

    const next = stream.next();
    const rejection = expect(next).rejects.toMatchObject({
      code: 'MODEL_STREAM_IDLE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('preserves caller abort reasons instead of reporting a timeout', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const service = createService({
      chat: vi.fn(async (_messages, _tools, signal) => {
        providerSignal = signal;
        return await new Promise<never>(() => {});
      }),
    });
    const wrapped = wrapChatServiceWithTimeouts(service);
    const reason = new Error('caller cancelled');
    const result = wrapped.chat([], undefined, abortController.signal);
    const rejection = expect(result).rejects.toBe(reason);

    abortController.abort(reason);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the provider generator when the consumer stops early', async () => {
    let providerClosed = false;
    let providerSignal: AbortSignal | undefined;
    const service = createService({
      async *streamChat(_messages, _tools, signal) {
        providerSignal = signal;
        try {
          yield { content: 'first' };
          yield { content: 'second' };
        } finally {
          providerClosed = true;
        }
      },
    });
    const stream = wrapChatServiceWithTimeouts(service).streamChat([]);

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { content: 'first' },
    });
    await stream.return(undefined);

    expect(providerClosed).toBe(true);
    expect(providerSignal?.aborted).toBe(true);
  });

  it('applies one request deadline across retry-event yields', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const service = createService(
      {
        async *chatWithRetryEvents(_messages, _tools, signal) {
          providerSignal = signal;
          yield {
            type: 'retry_attempt',
            attempt: 1,
            maxRetries: 3,
            delayMs: 10,
            error: { message: 'retry' },
          };
          await new Promise(() => {});
          return { content: 'unreachable' };
        },
      },
      { requestTimeoutMs: 50 },
    );
    const stream = wrapChatServiceWithTimeouts(service)
      .chatWithRetryEvents?.([]);
    expect(stream).toBeDefined();
    if (!stream) {
      throw new Error('Expected retry-event support');
    }

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'retry_attempt' },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(stream.next()).rejects.toMatchObject({
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 50,
    });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('does not invent retry-event support', () => {
    expect(
      wrapChatServiceWithTimeouts(createService()).chatWithRetryEvents,
    ).toBeUndefined();
  });

  it('rejects every invalid timeout configuration before use or update', () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
    for (const field of ['requestTimeoutMs', 'streamIdleTimeoutMs'] as const) {
      for (const value of invalidValues) {
        expect(() =>
          wrapChatServiceWithTimeouts(
            createService({}, { [field]: value }),
          )
        ).toThrow(ConfigError);
      }
    }

    const wrapped = wrapChatServiceWithTimeouts(createService());
    expect(() =>
      wrapped.updateConfig({ requestTimeoutMs: Number.POSITIVE_INFINITY })
    ).toThrow(ConfigError);
    expect(wrapped.getConfig().requestTimeoutMs).toBeUndefined();
  });

  it('honors the legacy ChatConfig timeout as the request deadline', async () => {
    vi.useFakeTimers();
    const service = createService(
      {
        async sideQuery() {
          return await new Promise<never>(() => {});
        },
      },
      { timeout: 25 },
    );
    const result = wrapChatServiceWithTimeouts(service).sideQuery([]);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });
});
