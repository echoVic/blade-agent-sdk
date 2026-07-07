import { describe, expect, it } from 'vitest';
import { TokenBudget } from '../index.js';

describe('TokenBudget', () => {
  it('tracks cache-aware usage, estimated cost, warning, and exhaustion state', () => {
    const budget = new TokenBudget({
      maxTotalTokens: 100,
      warningThresholdPercent: 0.5,
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
      costPerCacheReadToken: 0.0001,
    });

    budget.record({
      promptTokens: 60,
      completionTokens: 20,
      totalTokens: 80,
      cacheReadInputTokens: 10,
      cacheMissInputTokens: 50,
      billableInputTokens: 50,
    });

    expect(budget.isWarning()).toBe(true);
    expect(budget.isApproachingLimit()).toBe(false);
    expect(budget.isExhausted()).toBe(false);
    expect(budget.getSnapshot()).toEqual({
      totalInputTokens: 60,
      totalBillableInputTokens: 50,
      totalOutputTokens: 20,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 10,
      totalCacheMissTokens: 50,
      totalTokens: 80,
      estimatedCost: 0.091,
      budgetRemaining: 20,
      budgetPercent: 0.8,
    });

    budget.record({
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
    });

    expect(budget.isApproachingLimit()).toBe(true);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.getSnapshot()).toMatchObject({
      totalTokens: 100,
      budgetRemaining: 0,
      budgetPercent: 1,
    });
  });

  it('uses totalTokens when providers omit token breakdowns', () => {
    const budget = new TokenBudget({
      maxTotalTokens: 100,
      warningThresholdPercent: 0.5,
    });

    budget.record({ totalTokens: 75 });

    expect(budget.isWarning()).toBe(true);
    expect(budget.isExhausted()).toBe(false);
    expect(budget.getSnapshot()).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 75,
      budgetRemaining: 25,
      budgetPercent: 0.75,
    });

    budget.record({ totalTokens: 25 });

    expect(budget.isExhausted()).toBe(true);
    expect(budget.getSnapshot()).toMatchObject({
      totalTokens: 100,
      budgetRemaining: 0,
      budgetPercent: 1,
    });
  });
});
