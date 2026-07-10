import type { ModelUsageInfo } from '@blade-ai/ai';
import type { AgentTokenBudgetPort, AgentTokenBudgetSnapshot } from '../protocol/index.js';

const DEFAULT_WARNING_THRESHOLD = 0.8;
const APPROACHING_LIMIT_THRESHOLD = 0.95;
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

interface ResolvedTokenBudgetConfig {
  maxTotalTokens?: number;
  warningThresholdPercent: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  costPerCacheWriteToken: number;
  costPerCacheReadToken: number;
}

export type TokenBudgetSnapshot = AgentTokenBudgetSnapshot;

export class TokenBudget implements AgentTokenBudgetPort {
  private inputTokens = 0;
  private billableInputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private cacheMissTokens = 0;
  private unattributedTokens = 0;
  private recentOutputTokens: number[] = [];
  private readonly config: ResolvedTokenBudgetConfig;

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

  record(usage: ModelUsageInfo): void {
    const inputDelta = usage.promptTokens ?? 0;
    const outputDelta = usage.completionTokens ?? 0;
    const attributedDelta = inputDelta + outputDelta;
    const totalDelta = usage.totalTokens ?? attributedDelta;
    const billableInputDelta =
      usage.billableInputTokens ?? usage.cacheMissInputTokens ?? inputDelta;

    this.inputTokens += inputDelta;
    this.unattributedTokens += Math.max(totalDelta - attributedDelta, 0);
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

  isWarning(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }
    return this.totalTokens >= this.config.maxTotalTokens * this.config.warningThresholdPercent;
  }

  isApproachingLimit(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }
    return this.totalTokens >= this.config.maxTotalTokens * APPROACHING_LIMIT_THRESHOLD;
  }

  isExhausted(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }
    return this.totalTokens >= this.config.maxTotalTokens;
  }

  isDiminishingReturns(): boolean {
    if (this.recentOutputTokens.length < DIMINISHING_RETURNS_CONSECUTIVE_TURNS) {
      return false;
    }
    return this.recentOutputTokens.every((tokens) => tokens < DIMINISHING_RETURNS_MIN_TOKENS);
  }

  shouldCompact(): boolean {
    return this.isWarning() && !this.isExhausted();
  }

  getSnapshot(): AgentTokenBudgetSnapshot {
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

  reset(): void {
    this.inputTokens = 0;
    this.billableInputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheMissTokens = 0;
    this.unattributedTokens = 0;
    this.recentOutputTokens = [];
  }

  private get totalTokens(): number {
    return this.inputTokens + this.outputTokens + this.unattributedTokens;
  }
}
