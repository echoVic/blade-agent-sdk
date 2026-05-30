import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDeepSeekCost,
  createDeepSeekBatchChatCompletions,
  createDeepSeekChatCompletion,
  createDeepSeekLongContextPlan,
  createDeepSeekTokenBudgetCostConfig,
  createDeepSeekFimCompletion,
  DeepSeekCostTracker,
  createDeepSeekLongContextChunks,
  createDeepSeekLongContextMessages,
  estimateDeepSeekTokens,
  getDeepSeekPricing,
  mergeDeepSeekUsage,
  optimizeDeepSeekCachePrefix,
  prepareDeepSeekTools,
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  sanitizeDeepSeekStrictSchema,
  serializeDeepSeekTools,
  summarizeDeepSeekBatchChatCompletions,
  shouldUseDeepSeekBetaBaseUrl,
  shouldOmitDeepSeekSamplingOptions,
  withDeepSeekDefaults,
} from '../deepseek.js';

describe('DeepSeek provider helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes legacy model aliases and default base URL', () => {
    expect(normalizeDeepSeekModel(undefined)).toBe('deepseek-v4-pro');
    expect(normalizeDeepSeekModel('deepseek-chat')).toBe('deepseek-v4-flash');
    expect(normalizeDeepSeekModel('deepseek-reasoner')).toBe('deepseek-v4-flash');
    expect(normalizeDeepSeekModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(resolveDeepSeekBaseUrl()).toBe('https://api.deepseek.com');
    expect(resolveDeepSeekBaseUrl(undefined, true)).toBe('https://api.deepseek.com/beta');
  });

  it('provides cache-aware DeepSeek token budget cost config', () => {
    expect(getDeepSeekPricing('deepseek-chat')).toEqual(getDeepSeekPricing('deepseek-v4-flash'));
    expect(getDeepSeekPricing('deepseek-r1')).toEqual({
      inputCacheHit: 0.14 / 1_000_000,
      inputCacheMiss: 0.55 / 1_000_000,
      output: 2.19 / 1_000_000,
    });
    expect(createDeepSeekTokenBudgetCostConfig('deepseek-v4-pro')).toEqual({
      costPerInputToken: 0.435 / 1_000_000,
      costPerOutputToken: 0.87 / 1_000_000,
      costPerCacheReadToken: 0.003625 / 1_000_000,
    });
    expect(createDeepSeekTokenBudgetCostConfig('unknown-model')).toBeUndefined();
  });

  it('calculates DeepSeek cost with cache hit, cache miss, and reasoning breakdown', () => {
    expect(calculateDeepSeekCost({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 70,
      cacheMissInputTokens: 30,
      billableInputTokens: 30,
      reasoningTokens: 5,
    }, 'deepseek-v4-pro')).toMatchObject({
      model: 'deepseek-v4-pro',
      inputCacheHitTokens: 70,
      inputCacheMissTokens: 30,
      outputTokens: 15,
      reasoningOutputTokens: 5,
      totalCost: (70 * 0.003625 + 30 * 0.435 + 20 * 0.87) / 1_000_000,
      currency: 'USD',
    });
  });

  it('maps DeepSeek provider cache metadata when token details are absent', () => {
    expect(mergeDeepSeekUsage(
      {
        promptTokens: 20,
        completionTokens: 3,
        totalTokens: 23,
      },
      {
        deepseek: {
          promptCacheHitTokens: 12,
          promptCacheMissTokens: 8,
        },
      },
    )).toMatchObject({
      promptTokens: 20,
      completionTokens: 3,
      totalTokens: 23,
      cacheReadInputTokens: 12,
      cacheMissInputTokens: 8,
      billableInputTokens: 8,
    });

    expect(mergeDeepSeekUsage({
      inputTokens: 20,
      outputTokens: 3,
      cachedInputTokens: 12,
    })).toMatchObject({
      promptTokens: 20,
      completionTokens: 3,
      totalTokens: 23,
      cacheReadInputTokens: 12,
      billableInputTokens: 8,
    });
  });

  it('applies DeepSeek model defaults', () => {
    expect(withDeepSeekDefaults({
      id: 'd',
      name: 'DeepSeek',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      temperature: 0.3,
    });

    expect(withDeepSeekDefaults({
      id: 'r',
      name: 'DeepSeek Reasoner',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      supportsThinking: true,
      thinkingEnabled: true,
    });
  });

  it('moves stable DeepSeek prefix messages before volatile prefill context', () => {
    const optimized = optimizeDeepSeekCachePrefix([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'volatile question' },
      { role: 'user', content: 'stable repo map', metadata: { deepseekCache: 'stable' } },
      { role: 'assistant', content: 'prior answer' },
    ]);

    expect(optimized.map((message) => message.content)).toEqual([
      'policy',
      'stable repo map',
      'volatile question',
      'prior answer',
    ]);
  });

  it('creates stable long-context chunks and messages for 64K/128K workflows', () => {
    const chunks = createDeepSeekLongContextChunks('a'.repeat(20), {
      chunkTokenLimit: 2,
      charsPerToken: 2,
      chunkPrefix: 'doc',
    });

    expect(estimateDeepSeekTokens('abcdef', 2)).toBe(3);
    expect(chunks).toEqual([
      { id: 'doc_1', index: 0, content: 'aaaa', estimatedTokens: 2, contentHash: '4ceb2db9', cacheKey: 'doc:1:4' },
      { id: 'doc_2', index: 1, content: 'aaaa', estimatedTokens: 2, contentHash: '4ceb2db9', cacheKey: 'doc:2:4' },
      { id: 'doc_3', index: 2, content: 'aaaa', estimatedTokens: 2, contentHash: '4ceb2db9', cacheKey: 'doc:3:4' },
      { id: 'doc_4', index: 3, content: 'aaaa', estimatedTokens: 2, contentHash: '4ceb2db9', cacheKey: 'doc:4:4' },
      { id: 'doc_5', index: 4, content: 'aaaa', estimatedTokens: 2, contentHash: '4ceb2db9', cacheKey: 'doc:5:4' },
    ]);
    expect(createDeepSeekLongContextMessages('abcdef', {
      chunkTokenLimit: 2,
      charsPerToken: 2,
      chunkPrefix: 'doc',
    })[0]).toMatchObject({
      role: 'user',
      metadata: {
        deepseekCache: 'stable',
        deepseek: {
          cache: 'stable',
          chunkId: 'doc_1',
          contentHash: expect.any(String),
        },
      },
    });
  });

  it('plans long context chunks within explicit input budgets', () => {
    const plan = createDeepSeekLongContextPlan('a'.repeat(24), {
      chunkTokenLimit: 3,
      charsPerToken: 2,
      maxContextTokens: 10,
      reserveOutputTokens: 4,
      chunkPrefix: 'doc',
    });

    expect(plan).toMatchObject({
      totalEstimatedTokens: 12,
      includedEstimatedTokens: 6,
      omittedEstimatedTokens: 6,
      includedChunkCount: 2,
      omittedChunkCount: 2,
      maxContextTokens: 10,
      reserveOutputTokens: 4,
    });
    expect(plan.messages).toHaveLength(2);
    expect(plan.messages[0]?.metadata).toMatchObject({
      deepseek: {
        cache: 'stable',
        chunkId: 'doc_1',
        estimatedTokens: 3,
      },
    });
  });

  it('tracks aggregate DeepSeek usage, cache hit rate, and costs', () => {
    const tracker = new DeepSeekCostTracker('deepseek-v4-pro');

    tracker.recordUsage({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cacheReadInputTokens: 80,
      cacheMissInputTokens: 20,
      billableInputTokens: 20,
      reasoningTokens: 4,
    });
    tracker.recordUsage({
      promptTokens: 50,
      completionTokens: 5,
      totalTokens: 55,
      cacheReadInputTokens: 20,
      cacheMissInputTokens: 30,
      billableInputTokens: 30,
    });

    expect(tracker.getSnapshot()).toMatchObject({
      model: 'deepseek-v4-pro',
      requestCount: 2,
      promptTokens: 150,
      completionTokens: 15,
      totalTokens: 165,
      inputCacheHitTokens: 100,
      inputCacheMissTokens: 50,
      outputTokens: 11,
      reasoningOutputTokens: 4,
      cacheHitRate: 100 / 150,
      totalCost: (100 * 0.003625 + 50 * 0.435 + 15 * 0.87) / 1_000_000,
    });
  });

  it('sanitizes object schemas for DeepSeek strict tools', () => {
    expect(sanitizeDeepSeekStrictSchema({
      type: 'object',
      properties: {
        q: { type: 'string', format: 'date-time' },
        count: { type: 'number' },
        email: { type: ['string', 'null'], format: 'email' },
        nested: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 8 },
            choice: {
              oneOf: [
                { type: 'string', minLength: 1 },
                { type: 'integer' },
              ],
            },
          },
          required: [],
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['q'],
      allOf: [{ type: 'object' }],
      propertyNames: { pattern: '^[a-z]+$' },
    })).toMatchObject({
      required: ['q', 'count', 'email', 'nested', 'tags'],
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        email: { type: 'string', format: 'email' },
        nested: {
          required: ['name', 'choice'],
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            choice: {
              anyOf: [
                { type: 'string' },
                { type: 'integer' },
              ],
            },
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
    expect(sanitizeDeepSeekStrictSchema({
      type: 'object',
      properties: {},
      allOf: [{ type: 'object' }],
      propertyNames: { pattern: '^[a-z]+$' },
    })).not.toHaveProperty('allOf');
  });

  it('prepares DeepSeek strict tools and beta endpoint selection', () => {
    const tools = prepareDeepSeekTools([
      {
        name: 'search',
        description: 'Search files',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 1 },
          },
        },
      },
    ], { strictTools: true });

    expect(shouldUseDeepSeekBetaBaseUrl({
      provider: 'deepseek',
      deepseek: { strictTools: true },
    })).toBe(true);
    expect(tools?.[0]).toMatchObject({
      name: 'search',
      strict: true,
      parameters: {
        required: ['q'],
        additionalProperties: false,
        properties: {
          q: { type: 'string' },
        },
      },
    });
    expect(serializeDeepSeekTools([
      {
        name: 'search',
        description: 'Search files',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
          },
        },
      },
    ], { strictTools: true })?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search files',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
          },
          required: ['q'],
          additionalProperties: false,
        },
      },
    });
  });

  it('normalizes empty and legacy-def schemas for DeepSeek strict tools', () => {
    expect(prepareDeepSeekTools([
      {
        name: 'ping',
        description: 'Ping',
        parameters: {},
      },
    ], { strictTools: true })?.[0]?.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });

    expect(sanitizeDeepSeekStrictSchema({
      type: 'object',
      properties: {
        item: { $ref: '#/$def/Item' },
      },
      $def: {
        Item: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    } as never)).toMatchObject({
      required: ['item'],
      additionalProperties: false,
      $def: {
        Item: {
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
          },
        },
      },
    });
  });

  it('leaves non-strict DeepSeek tool schemas unchanged', () => {
    const parameters = {
      type: 'object' as const,
      properties: {
        q: { type: 'string' as const, minLength: 1 },
      },
      required: [],
      additionalProperties: true,
    };

    expect(prepareDeepSeekTools([
      {
        name: 'search',
        description: 'Search files',
        parameters,
      },
    ])?.[0]).toEqual({
      name: 'search',
      description: 'Search files',
      parameters,
    });
  });

  it('omits sampling options only for enabled DeepSeek thinking mode', () => {
    expect(shouldOmitDeepSeekSamplingOptions({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })).toBe(true);
    expect(shouldOmitDeepSeekSamplingOptions({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      deepseek: { thinking: { type: 'enabled' } },
    })).toBe(true);
    expect(shouldOmitDeepSeekSamplingOptions({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      deepseek: { thinking: { type: 'disabled' } },
    })).toBe(false);
    expect(shouldOmitDeepSeekSamplingOptions({
      provider: 'openai',
      model: 'deepseek-reasoner',
    })).toBe(false);
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

  it('surfaces DeepSeek FIM API error messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'invalid suffix',
        },
      }),
    })));

    await expect(createDeepSeekFimCompletion({
      apiKey: 'test-key',
      prompt: 'left',
      suffix: 'right',
    })).rejects.toThrow('invalid suffix');
  });

  it('creates DeepSeek chat completion requests with usage cost', async () => {
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
