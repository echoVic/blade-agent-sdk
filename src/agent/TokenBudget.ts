import type { ModelUsage } from '../model/usage.js';

const DEFAULT_WARNING_THRESHOLD = 0.8;
const DIMINISHING_RETURNS_MIN_TOKENS = 500;
const DIMINISHING_RETURNS_CONSECUTIVE_TURNS = 3;

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
  totalBillableInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalCacheMissTokens: number;
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
  private billableInputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private cacheMissTokens = 0;
  private readonly config: ResolvedTokenBudgetConfig;

  private recentOutputTokens: number[] = [];

  constructor(config: TokenBudgetConfig = {}) {
    this.config = {
      maxTotalTokens: config.maxTotalTokens,
      warningThresholdPercent: config.warningThresholdPercent ?? DEFAULT_WARNING_THRESHOLD,
      costPerInputToken: config.costPerInputToken ?? 0,
      costPerOutputToken: config.costPerOutputToken ?? 0,
      costPerCacheWriteToken: config.costPerCacheWriteToken ?? 0,
      costPerCacheReadToken: config.costPerCacheReadToken ?? 0,
    };
  }

  record(usage: ModelUsage): void {
    const outputDelta = usage.completionTokens ?? 0;
    const inputDelta = usage.promptTokens ?? 0;
    const billableInputDelta =
      usage.billableInputTokens ?? usage.cacheMissInputTokens ?? inputDelta;
    this.inputTokens += inputDelta;
    this.billableInputTokens += billableInputDelta;
    this.outputTokens += outputDelta;
    this.cacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
    this.cacheMissTokens += usage.cacheMissInputTokens ?? billableInputDelta;

    this.recentOutputTokens.push(outputDelta);
    if (this.recentOutputTokens.length > DIMINISHING_RETURNS_CONSECUTIVE_TURNS) {
      this.recentOutputTokens.shift();
    }
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  isExhausted(): boolean {
    if (this.config.maxTotalTokens === undefined) return false;
    return this.totalTokens >= this.config.maxTotalTokens;
  }

  isWarning(): boolean {
    if (this.config.maxTotalTokens === undefined) return false;
    return this.totalTokens >= this.config.maxTotalTokens * this.config.warningThresholdPercent;
  }

  isDiminishingReturns(): boolean {
    if (this.recentOutputTokens.length < DIMINISHING_RETURNS_CONSECUTIVE_TURNS) {
      return false;
    }
    return this.recentOutputTokens.every((t) => t < DIMINISHING_RETURNS_MIN_TOKENS);
  }

  getSnapshot(): TokenBudgetSnapshot {
    const estimatedCost =
      this.billableInputTokens * this.config.costPerInputToken +
      this.outputTokens * this.config.costPerOutputToken +
      this.cacheWriteTokens * this.config.costPerCacheWriteToken +
      this.cacheReadTokens * this.config.costPerCacheReadToken;

    const budgetRemaining =
      this.config.maxTotalTokens === undefined
        ? null
        : Math.max(this.config.maxTotalTokens - this.totalTokens, 0);
    const budgetPercent =
      this.config.maxTotalTokens === undefined
        ? null
        : this.totalTokens / this.config.maxTotalTokens;

    return {
      totalInputTokens: this.inputTokens,
      totalBillableInputTokens: this.billableInputTokens,
      totalOutputTokens: this.outputTokens,
      totalCacheWriteTokens: this.cacheWriteTokens,
      totalCacheReadTokens: this.cacheReadTokens,
      totalCacheMissTokens: this.cacheMissTokens,
      totalTokens: this.totalTokens,
      estimatedCost,
      budgetRemaining,
      budgetPercent,
    };
  }
}
