import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekFimCompletion,
  prepareDeepSeekTools,
  normalizeDeepSeekModel,
  resolveDeepSeekBaseUrl,
  sanitizeDeepSeekStrictSchema,
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
        q: { type: 'string' },
        count: { type: 'number' },
        nested: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 8 },
          },
          required: [],
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['q'],
    })).toMatchObject({
      required: ['q', 'count', 'nested', 'tags'],
      additionalProperties: false,
      properties: {
        nested: {
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
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
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
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
    });
  });
});
