import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekBatchChatCompletions,
  createDeepSeekChatCompletion,
  createDeepSeekFimCompletion,
  summarizeDeepSeekBatchChatCompletions,
} from '../index.js';

describe('DeepSeek runtime API helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates FIM completion requests against the beta endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({
        id: 'fim_1',
        model: 'deepseek-v4-pro',
        choices: [{ text: 'middle', finish_reason: 'stop', index: 0 }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
          prompt_cache_hit_tokens: 1,
          prompt_cache_miss_tokens: 1,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createDeepSeekFimCompletion({
      apiKey: 'test-key',
      prompt: 'left',
      suffix: 'right',
      maxTokens: 64,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/beta/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      model: 'deepseek-v4-pro',
      prompt: 'left',
      suffix: 'right',
      max_tokens: 64,
      stream: false,
    });
    expect(response.choices[0]?.text).toBe('middle');
    expect(response.usage).toMatchObject({
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
      cacheReadInputTokens: 1,
      cacheMissInputTokens: 1,
      billableInputTokens: 1,
      reasoningTokens: 0,
    });
  });

  it('creates DeepSeek chat completion requests with usage cost and cache optimization', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({
        id: 'chat_1',
        model: 'deepseek-v4-pro',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 3,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createDeepSeekChatCompletion({
      apiKey: 'test-key',
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'question' },
        { role: 'user', content: 'stable repo map', metadata: { deepseekCache: 'stable' } },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    expect(response.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 3,
      cacheReadInputTokens: 7,
      cacheMissInputTokens: 3,
    });
    expect(response.cost?.inputCacheHitTokens).toBe(7);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string).messages).toEqual([
      { role: 'user', content: 'stable repo map' },
      { role: 'user', content: 'question' },
    ]);
  });

  it('runs DeepSeek batch chat completions with per-item results', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
      if (body.messages[0]?.content === 'fail') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'bad request' } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await createDeepSeekBatchChatCompletions({
      apiKey: 'test-key',
      concurrency: 2,
      requests: [
        { id: 'a', messages: [{ role: 'user', content: 'ok' }] },
        { id: 'b', messages: [{ role: 'user', content: 'fail' }] },
      ],
    });

    expect(results[0]?.response?.choices[0]?.message?.content).toBe('ok');
    expect(results[1]?.error?.message).toBe('bad request');
    expect(summarizeDeepSeekBatchChatCompletions(results, 'deepseek-v4-pro')).toMatchObject({
      successCount: 1,
      errorCount: 1,
      requestCount: 1,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });
  });
});
