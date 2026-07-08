import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopBudgetWarningEvent,
  buildAgentLoopTokenUsageEvent,
  buildAgentLoopTokenUsageInfo,
} from '../loop/tokenUsage.js';

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

  it('wraps token usage info as a public agent event', () => {
    const usage = buildAgentLoopTokenUsageInfo({
      modelUsage: {
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
      },
      totalTokens: 20,
      maxContextTokens: 100,
    });

    expect(buildAgentLoopTokenUsageEvent({ usage })).toEqual({
      type: 'token_usage',
      usage,
    });
  });

  it('wraps token budget snapshots as public warning events', () => {
    const snapshot = {
      totalTokens: 80,
      budgetRemaining: 20,
      budgetPercent: 0.8,
    };

    expect(buildAgentLoopBudgetWarningEvent({ snapshot })).toEqual({
      type: 'budget_warning',
      snapshot,
    });
  });
});
