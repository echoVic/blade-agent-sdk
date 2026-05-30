import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekTokenBudgetCostConfig,
  createDeepSeekFimCompletion,
  getDeepSeekPricing,
  mergeDeepSeekUsage,
  prepareDeepSeekTools,
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  sanitizeDeepSeekStrictSchema,
  serializeDeepSeekTools,
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
    expect(createDeepSeekTokenBudgetCostConfig('deepseek-v4-pro')).toEqual({
      costPerInputToken: 0.435 / 1_000_000,
      costPerOutputToken: 0.87 / 1_000_000,
      costPerCacheReadToken: 0.003625 / 1_000_000,
    });
    expect(createDeepSeekTokenBudgetCostConfig('unknown-model')).toBeUndefined();
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
});
