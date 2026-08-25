import { describe, expect, it } from 'vitest';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelRetryEvent } from '../../model/retry.js';
import type { ModelResponse, ModelService } from '../../model/service.js';
import type { ModelMiddleware } from '../ModelMiddleware.js';
import { wrapModelService } from '../ModelMiddleware.js';

function createService(calls: string[]): ModelService {
  let config: ModelServiceConfig = {
    provider: 'openai-compatible',
    apiKey: 'test',
    baseUrl: 'https://example.test',
    model: 'base-model',
  };

  return {
    async chat(messages) {
      calls.push(`chat:${messages.at(-1)?.content}`);
      return { content: 'base' };
    },
    async sideQuery(messages) {
      calls.push(`side:${messages.at(-1)?.content}`);
      return { content: 'side' };
    },
    async *streamChat(messages) {
      calls.push(`stream:${messages.at(-1)?.content}`);
      yield { content: 'chunk' };
    },
    async *chatWithRetryEvents(messages) {
      calls.push(`retry:${messages.at(-1)?.content}`);
      yield {
        type: 'retry_attempt',
        attempt: 1,
        maxRetries: 2,
        delayMs: 1,
        error: { message: 'retry' },
      };
      return { content: 'retried' };
    },
    getConfig() {
      return config;
    },
    updateConfig(next) {
      config = { ...config, ...next };
    },
  };
}

describe('wrapModelService', () => {
  it('wraps unary model calls in onion order and allows request/response transforms', async () => {
    const calls: string[] = [];
    const middleware: ModelMiddleware[] = [
      {
        async wrapChat(request, next) {
          calls.push('first:before');
          const response = await next({
            ...request,
            messages: [...request.messages, { role: 'user', content: 'first' }],
          });
          calls.push('first:after');
          return { ...response, content: `${response.content}:first` };
        },
      },
      {
        async wrapChat(request, next) {
          calls.push('second:before');
          const response = await next(request);
          calls.push('second:after');
          return { ...response, content: `${response.content}:second` };
        },
      },
    ];
    const wrapped = wrapModelService(createService(calls), middleware);

    await expect(wrapped.chat([{ role: 'user', content: 'original' }])).resolves.toEqual({
      content: 'base:second:first',
    });
    expect(calls).toEqual([
      'first:before',
      'second:before',
      'chat:first',
      'second:after',
      'first:after',
    ]);
  });

  it('rejects AbortSignal replacement before nested middleware short-circuits', async () => {
    const calls: string[] = [];
    const original = new AbortController();
    const replacement = new AbortController();
    const wrapped = wrapModelService(createService(calls), [
      {
        wrapChat(request, next) {
          return next({
            ...request,
            signal: replacement.signal,
          });
        },
      },
      {
        async wrapChat() {
          return { content: 'short-circuit' };
        },
      },
    ]);

    await expect(
      wrapped.chat([{ role: 'user', content: 'input' }], undefined, original.signal),
    ).rejects.toThrow('Model middleware cannot replace the AbortSignal');
    expect(calls).toEqual([]);
  });

  it('wraps streaming and retry-aware model calls without buffering', async () => {
    const calls: string[] = [];
    const middleware: ModelMiddleware = {
      async *wrapStream(request, next) {
        calls.push('stream:before');
        for await (const chunk of next(request)) {
          yield { ...chunk, content: chunk.content?.toUpperCase() };
        }
        calls.push('stream:after');
      },
      async *wrapChatWithRetryEvents(request, next) {
        calls.push('retry:before');
        const execution = next(request);
        while (true) {
          const step = await execution.next();
          if (step.done) {
            calls.push('retry:after');
            return { ...step.value, content: `${step.value.content}:wrapped` };
          }
          yield step.value;
        }
      },
    };
    const wrapped = wrapModelService(createService(calls), [middleware]);

    const chunks = [];
    for await (const chunk of wrapped.streamChat([{ role: 'user', content: 'input' }])) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ content: 'CHUNK' }]);

    const retry = wrapped.chatWithRetryEvents?.([{ role: 'user', content: 'input' }]);
    expect(retry).toBeDefined();
    const events: ModelRetryEvent[] = [];
    let response: ModelResponse | undefined;
    while (retry) {
      const step = await retry.next();
      if (step.done) {
        response = step.value;
        break;
      }
      events.push(step.value);
    }

    expect(events).toHaveLength(1);
    expect(response).toEqual({ content: 'retried:wrapped' });
    expect(calls).toEqual([
      'stream:before',
      'stream:input',
      'stream:after',
      'retry:before',
      'retry:input',
      'retry:after',
    ]);
  });

  it('preserves config access and optional retry capability', () => {
    const calls: string[] = [];
    const base = createService(calls);
    const wrapped = wrapModelService(base, [{}]);

    wrapped.updateConfig({ model: 'next-model' });

    expect(wrapped.getConfig().model).toBe('next-model');
    expect(wrapped.chatWithRetryEvents).toBeTypeOf('function');
  });

  it('does not invent retry capability when the provider does not expose it', () => {
    const calls: string[] = [];
    const service = createService(calls);
    service.chatWithRetryEvents = undefined;

    const wrapped = wrapModelService(service, [{}]);

    expect(wrapped.chatWithRetryEvents).toBeUndefined();
  });

  it('closes middleware and provider streams when the consumer stops early', async () => {
    let providerClosed = false;
    let middlewareClosed = false;
    const base = createService([]);
    base.streamChat = async function* () {
      try {
        yield { content: 'first' };
        yield { content: 'second' };
      } finally {
        providerClosed = true;
      }
    };
    const wrapped = wrapModelService(base, [
      {
        async *wrapStream(request, next) {
          try {
            yield* next(request);
          } finally {
            middlewareClosed = true;
          }
        },
      },
    ]);
    const stream = wrapped.streamChat([{ role: 'user', content: 'input' }]);

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { content: 'first' },
    });
    await stream.return(undefined);

    expect(middlewareClosed).toBe(true);
    expect(providerClosed).toBe(true);
  });
});
