import { describe, expect, it } from 'vitest';
import { buildAgentLoopTokenUsageInfo } from '../loop/tokenUsage.js';

describe('agent loop token usage projection', () => {
  it('builds token usage info from model usage and loop totals', () => {
    const usage = buildAgentLoopTokenUsageInfo({
      modelUsage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        cacheReadInputTokens: 3,
        cacheMissInputTokens: 8,
        billableInputTokens: 8,
        reasoningTokens: 2,
      },
      totalTokens: 40,
      maxContextTokens: 128000,
    });

    expect(usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 40,
      maxContextTokens: 128000,
      cacheReadInputTokens: 3,
      cacheMissInputTokens: 8,
      billableInputTokens: 8,
      reasoningTokens: 2,
    });
  });

  it('defaults missing input and output token counts to zero', () => {
    const usage = buildAgentLoopTokenUsageInfo({
      modelUsage: { totalTokens: 0 },
      totalTokens: 0,
      maxContextTokens: 1024,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      maxContextTokens: 1024,
      cacheReadInputTokens: undefined,
      cacheMissInputTokens: undefined,
      billableInputTokens: undefined,
      reasoningTokens: undefined,
    });
  });
});
