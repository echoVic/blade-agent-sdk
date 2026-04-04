import type { UsageInfo } from '../services/ChatServiceInterface.js';

/** Threshold at which a budget warning is emitted (80%). */
const DEFAULT_WARNING_THRESHOLD = 0.8;
/** Threshold at which the agent should stop accepting new turns (95%). */
const APPROACHING_LIMIT_THRESHOLD = 0.95;
/** Minimum output tokens per turn before diminishing-returns detection kicks in. */
const DIMINISHING_RETURNS_MIN_TOKENS = 500;
/** Number of consecutive low-yield turns before the agent stops. */
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

  /** Output tokens yielded in each of the last N turns (for diminishing-returns detection). */
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

  record(usage: UsageInfo): void {
    const outputDelta = usage.completionTokens ?? 0;
    this.inputTokens += usage.promptTokens ?? 0;
    this.outputTokens += outputDelta;
    this.cacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadInputTokens ?? 0;

    // Track recent per-turn output for diminishing-returns detection.
    this.recentOutputTokens.push(outputDelta);
    if (this.recentOutputTokens.length > DIMINISHING_RETURNS_CONSECUTIVE_TURNS) {
      this.recentOutputTokens.shift();
    }
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

  /** True when token usage crosses the warning threshold (default 80%). */
  isWarning(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }
    return this.totalTokens >= this.config.maxTotalTokens * this.config.warningThresholdPercent;
  }

  /**
   * True when token usage is close to the hard limit (95%).
   * At this point the agent should stop accepting new turns even if not exhausted.
   */
  isApproachingLimit(): boolean {
    if (this.config.maxTotalTokens === undefined) {
      return false;
    }
    return this.totalTokens >= this.config.maxTotalTokens * APPROACHING_LIMIT_THRESHOLD;
  }

  /**
   * True when the last N consecutive turns each produced fewer than
   * DIMINISHING_RETURNS_MIN_TOKENS output tokens, indicating the model is
   * spinning without making progress.
   *
   * Only fires after at least DIMINISHING_RETURNS_CONSECUTIVE_TURNS turns have
   * been recorded, so it never triggers prematurely on a fresh session.
   */
  isDiminishingReturns(): boolean {
    if (this.recentOutputTokens.length < DIMINISHING_RETURNS_CONSECUTIVE_TURNS) {
      return false;
    }
    return this.recentOutputTokens.every((t) => t < DIMINISHING_RETURNS_MIN_TOKENS);
  }

  /**
   * True when the agent should proactively compact its context.
   * Fires at the warning threshold so compaction happens before hitting the limit.
   */
  shouldCompact(): boolean {
    return this.isWarning() && !this.isExhausted();
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
    this.recentOutputTokens = [];
  }
}

