import { describe, expect, it } from 'vitest';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
} from '../../services/ChatServiceInterface.js';
import type { RetryEvent } from '../../services/RetryPolicy.js';
import type { ModelMiddleware } from '../ModelMiddleware.js';
import { wrapChatService } from '../ModelMiddleware.js';

function createService(calls: string[]): IChatService {
  let config: ChatConfig = {
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

describe('wrapChatService', () => {
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
    const wrapped = wrapChatService(createService(calls), middleware);

    await expect(
      wrapped.chat([{ role: 'user', content: 'original' }]),
    ).resolves.toEqual({ content: 'base:second:first' });
    expect(calls).toEqual([
      'first:before',
      'second:before',
      'chat:first',
      'second:after',
      'first:after',
    ]);
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
    const wrapped = wrapChatService(createService(calls), [middleware]);

    const chunks = [];
    for await (const chunk of wrapped.streamChat([{ role: 'user', content: 'input' }])) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ content: 'CHUNK' }]);

    const retry = wrapped.chatWithRetryEvents?.([{ role: 'user', content: 'input' }]);
    expect(retry).toBeDefined();
    const events: RetryEvent[] = [];
    let response: ChatResponse | undefined;
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
    const wrapped = wrapChatService(base, [{}]);

    wrapped.updateConfig({ model: 'next-model' });

    expect(wrapped.getConfig().model).toBe('next-model');
    expect(wrapped.chatWithRetryEvents).toBeTypeOf('function');
  });
});
