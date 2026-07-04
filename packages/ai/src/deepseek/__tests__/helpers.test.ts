import { describe, expect, it } from 'vitest';
import {
  calculateDeepSeekCost,
  createDeepSeekTokenBudgetCostConfig,
  getDeepSeekPricing,
  mergeDeepSeekUsage,
  normalizeDeepSeekModel,
  optimizeDeepSeekCachePrefix,
  prepareDeepSeekTools,
  resolveDeepSeekBaseUrl,
  shouldOmitDeepSeekSamplingOptions,
  shouldUseDeepSeekBetaBaseUrl,
  withDeepSeekDefaults,
} from '../index.js';

describe('DeepSeek provider helpers', () => {
  it('normalizes aliases, endpoints, and provider defaults without SDK model types', () => {
    expect(normalizeDeepSeekModel()).toBe('deepseek-v4-pro');
    expect(normalizeDeepSeekModel('deepseek-chat')).toBe('deepseek-v4-flash');
    expect(normalizeDeepSeekModel('deepseek-r1-0528')).toBe('deepseek-r1');
    expect(resolveDeepSeekBaseUrl('https://proxy.example.com/v1/')).toBe('https://proxy.example.com/v1');
    expect(resolveDeepSeekBaseUrl(undefined, true)).toBe('https://api.deepseek.com/beta');

    expect(withDeepSeekDefaults({
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      temperature: 0.3,
      supportsThinking: true,
      thinkingEnabled: true,
    });
  });

  it('calculates cache-aware pricing and token budget rates', () => {
    expect(getDeepSeekPricing('deepseek-chat')).toEqual(getDeepSeekPricing('deepseek-v4-flash'));
    expect(createDeepSeekTokenBudgetCostConfig('deepseek-v4-pro')).toEqual({
      costPerInputToken: 0.435 / 1_000_000,
      costPerOutputToken: 0.87 / 1_000_000,
      costPerCacheReadToken: 0.003625 / 1_000_000,
    });
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

  it('merges Vercel AI usage details with DeepSeek provider metadata', () => {
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
  });

  it('keeps stable DeepSeek cache prefix before volatile prefill messages', () => {
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

  it('sanitizes strict tool schemas and selects DeepSeek beta only when needed', () => {
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
    expect(shouldOmitDeepSeekSamplingOptions({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
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
});
