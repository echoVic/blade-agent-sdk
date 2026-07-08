import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentLoopTokenBudget,
  buildAgentLoopBudgetWarningEvent,
  buildAgentLoopTokenBudgetStopCompletion,
  buildAgentLoopTokenUsageEvent,
  buildAgentLoopTokenUsageInfo,
  buildAgentLoopTokenUsageInfoInput,
  shouldStopAgentLoopForTokenBudget,
  type AgentLoopTokenBudgetStopDecision,
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

  it('projects token usage info input from model usage and loop limits', () => {
    const modelUsage = {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    };

    expect(
      buildAgentLoopTokenUsageInfoInput({
        modelUsage,
        totalTokens: 40,
        maxContextTokens: 128000,
      }),
    ).toEqual({
      modelUsage,
      totalTokens: 40,
      maxContextTokens: 128000,
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

  it('skips token budget handling when budget or usage is missing', async () => {
    expect(
      await applyAgentLoopTokenBudget({
        tokenBudget: undefined,
        modelUsage: { totalTokens: 10 },
        tokensUsed: 10,
        turnsCount: 1,
        toolCallsCount: 0,
        startTime: 100,
        now: 140,
      }),
    ).toEqual({ events: [] });

    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => false),
      isDiminishingReturns: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({ totalTokens: 0 })),
    };

    expect(
      await applyAgentLoopTokenBudget({
        tokenBudget,
        modelUsage: undefined,
        tokensUsed: 0,
        turnsCount: 1,
        toolCallsCount: 0,
        startTime: 100,
        now: 140,
      }),
    ).toEqual({ events: [] });
    expect(tokenBudget.record).not.toHaveBeenCalled();
  });

  it('stops the loop only when the token budget decision has a result', () => {
    expect(shouldStopAgentLoopForTokenBudget({ events: [] })).toBe(false);
    expect(
      shouldStopAgentLoopForTokenBudget({
        events: [],
        result: {
          success: false,
          error: {
            type: 'budget_exhausted',
            message: 'Token budget exhausted',
          },
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 40,
            tokensUsed: 100,
            tokenBudgetSnapshot: { totalTokens: 100 },
          },
        },
      }),
    ).toBe(true);
  });

  it('builds token-budget stop completion after any budget warning events', () => {
    const snapshot = { totalTokens: 100 };
    const stopDecision: AgentLoopTokenBudgetStopDecision<typeof snapshot> = {
      events: [{ type: 'budget_warning' as const, snapshot }],
      result: {
        success: false,
        error: {
          type: 'budget_exhausted' as const,
          message: 'Token budget exhausted',
        },
        metadata: {
          turnsCount: 1,
          toolCallsCount: 0,
          duration: 40,
          tokensUsed: 100,
          tokenBudgetSnapshot: snapshot,
        },
      },
    };

    expect(buildAgentLoopTokenBudgetStopCompletion(stopDecision)).toEqual({
      action: 'stop',
      events: [
        { type: 'budget_warning', snapshot },
        { type: 'agent_end' },
      ],
      result: stopDecision.result,
    });
  });

  it('records usage and emits a token budget warning when warning thresholds are crossed', async () => {
    const usage = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
    const snapshot = { totalTokens: 92, budgetRemaining: 8, budgetPercent: 0.92 };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => true),
      isApproachingLimit: vi.fn(() => false),
      isDiminishingReturns: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(() => snapshot),
    };

    await expect(
      applyAgentLoopTokenBudget({
        tokenBudget,
        modelUsage: usage,
        tokensUsed: 92,
        turnsCount: 2,
        toolCallsCount: 4,
        startTime: 100,
        now: 140,
      }),
    ).resolves.toEqual({
      events: [{ type: 'budget_warning', snapshot }],
    });
    expect(tokenBudget.record).toHaveBeenCalledWith(usage);
  });

  it('builds the stop result when token budget reaches diminishing returns', async () => {
    const warningSnapshot = { totalTokens: 90, budgetRemaining: 10, budgetPercent: 0.9 };
    const stopSnapshot = { totalTokens: 95, budgetRemaining: 5, budgetPercent: 0.95 };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => true),
      isDiminishingReturns: vi.fn(() => true),
      isExhausted: vi.fn(() => true),
      getSnapshot: vi
        .fn()
        .mockReturnValueOnce(warningSnapshot)
        .mockReturnValueOnce(stopSnapshot),
    };

    await expect(
      applyAgentLoopTokenBudget({
        tokenBudget,
        modelUsage: { completionTokens: 1, totalTokens: 1 },
        tokensUsed: 95,
        turnsCount: 3,
        toolCallsCount: 7,
        startTime: 100,
        now: 140,
      }),
    ).resolves.toEqual({
      events: [{ type: 'budget_warning', snapshot: warningSnapshot }],
      result: {
        success: false,
        error: {
          type: 'budget_exhausted',
          message: 'Stopped due to diminishing returns: consecutive turns produced very few tokens',
        },
        metadata: {
          turnsCount: 3,
          toolCallsCount: 7,
          duration: 40,
          tokensUsed: 95,
          tokenBudgetSnapshot: stopSnapshot,
        },
      },
    });
  });
});
