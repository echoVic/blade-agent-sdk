import type { UsageInfo } from '../services/ChatServiceInterface.js';

export interface TokenBudgetConfig {
  maxTotalTokens?: number;
  warningThresholdPercent?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  costPerCacheWriteToken?: number;
  costPerCacheReadToken?: number;
}

export interface TokenBudgetSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  estimatedCost: number;
  budgetRemaining: number | null;
  budgetPercent: number | null;
}

interface ResolvedTokenBudgetConfig {
  maxTotalTokens?: number;
  warningThresholdPercent: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  costPerCacheWriteToken: number;
  costPerCacheReadToken: number;
}

export class TokenBudget {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private readonly config: ResolvedTokenBudgetConfig;

  constructor(config: TokenBudgetConfig = {}) {
    this.config = {
      maxTotalTokens: config.maxTotalTokens,
      warningThresholdPercent: config.warningThresholdPercent ?? 0.8,
      costPerInputToken: config.costPerInputToken ?? 0,
      costPerOutputToken: config.costPerOutputToken ?? 0,
      costPerCacheWriteToken: config.costPerCacheWriteToken ?? 0,
      costPerCacheReadToken: config.costPerCacheReadToken ?? 0,
    };
  }

  record(usage: UsageInfo): void {
    this.inputTokens += usage.promptTokens ?? 0;
    this.outputTokens += usage.completionTokens ?? 0;
    this.cacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  isExhausted(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }

    return this.totalTokens >= this.config.maxTotalTokens;
  }

  isWarning(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }

    return this.totalTokens >= this.config.maxTotalTokens * this.config.warningThresholdPercent;
  }

  getSnapshot(): TokenBudgetSnapshot {
    const estimatedCost =
      this.inputTokens * this.config.costPerInputToken
      + this.outputTokens * this.config.costPerOutputToken
      + this.cacheWriteTokens * this.config.costPerCacheWriteToken
      + this.cacheReadTokens * this.config.costPerCacheReadToken;

    const budgetRemaining = this.config.maxTotalTokens === undefined
      ? null
      : Math.max(this.config.maxTotalTokens - this.totalTokens, 0);
    const budgetPercent = this.config.maxTotalTokens === undefined
      ? null
      : this.totalTokens / this.config.maxTotalTokens;

    return {
      totalInputTokens: this.inputTokens,
      totalOutputTokens: this.outputTokens,
      totalCacheWriteTokens: this.cacheWriteTokens,
      totalCacheReadTokens: this.cacheReadTokens,
      totalTokens: this.totalTokens,
      estimatedCost,
      budgetRemaining,
      budgetPercent,
    };
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
  }
}
