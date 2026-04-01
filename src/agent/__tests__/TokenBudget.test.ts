import { describe, expect, it } from 'vitest';
import type { UsageInfo } from '../../services/ChatServiceInterface.js';
import { TokenBudget } from '../TokenBudget.js';

function createUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

describe('TokenBudget', () => {
  it('record() accumulates tokens correctly', () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });

    budget.record(createUsage({
      promptTokens: 100,
      completionTokens: 25,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
    }));
    budget.record(createUsage({
      promptTokens: 50,
      completionTokens: 10,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 2,
    }));

    const snapshot = budget.getSnapshot();
    expect(snapshot.totalInputTokens).toBe(150);
    expect(snapshot.totalOutputTokens).toBe(35);
    expect(snapshot.totalCacheWriteTokens).toBe(13);
    expect(snapshot.totalCacheReadTokens).toBe(7);
    expect(snapshot.totalTokens).toBe(185);
  });

  it('isExhausted() returns true when budget exceeded', () => {
    const budget = new TokenBudget({ maxTotalTokens: 100 });

    budget.record(createUsage({ promptTokens: 60, completionTokens: 40 }));

    expect(budget.isExhausted()).toBe(true);
  });

  it('isWarning() returns true at threshold', () => {
    const budget = new TokenBudget({
      maxTotalTokens: 100,
      warningThresholdPercent: 0.8,
    });

    budget.record(createUsage({ promptTokens: 50, completionTokens: 30 }));

    expect(budget.isWarning()).toBe(true);
  });

  it('getSnapshot() returns correct values including cost', () => {
    const budget = new TokenBudget({
      maxTotalTokens: 1000,
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
      costPerCacheWriteToken: 0.003,
      costPerCacheReadToken: 0.0005,
    });

    budget.record(createUsage({
      promptTokens: 100,
      completionTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 10,
    }));

    expect(budget.getSnapshot()).toEqual({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheWriteTokens: 20,
      totalCacheReadTokens: 10,
      totalTokens: 150,
      estimatedCost: 0.265,
      budgetRemaining: 850,
      budgetPercent: 0.15,
    });
  });

  it('reset() clears all counters', () => {
    const budget = new TokenBudget({ maxTotalTokens: 1000 });

    budget.record(createUsage({
      promptTokens: 100,
      completionTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 10,
    }));
    budget.reset();

    expect(budget.getSnapshot()).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      budgetRemaining: 1000,
      budgetPercent: 0,
    });
  });

  it('unlimited budget never exhausts', () => {
    const budget = new TokenBudget();

    budget.record(createUsage({
      promptTokens: 10_000,
      completionTokens: 5_000,
    }));

    expect(budget.isExhausted()).toBe(false);
    expect(budget.isWarning()).toBe(false);
    expect(budget.getSnapshot().budgetRemaining).toBeNull();
    expect(budget.getSnapshot().budgetPercent).toBeNull();
  });
});
