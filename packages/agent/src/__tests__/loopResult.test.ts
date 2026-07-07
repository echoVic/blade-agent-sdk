import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopAbortResult,
  buildAgentLoopBudgetExhaustedResult,
  buildAgentLoopSuccessResult,
} from '../loop/loopResult.js';

describe('agent loop result builders', () => {
  it('builds an abort result with deterministic loop metadata', () => {
    const result = buildAgentLoopAbortResult({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'aborted',
        message: '任务已被用户中止',
      },
      metadata: {
        turnsCount: 2,
        toolCallsCount: 3,
        duration: 75,
      },
    });
  });

  it('builds a token-budget exhausted result with usage metadata', () => {
    const snapshot = { usedTokens: 900, maxTokens: 900 };
    const result = buildAgentLoopBudgetExhaustedResult({
      reason: 'exhausted',
      turnsCount: 4,
      toolCallsCount: 5,
      startTime: 100,
      now: 190,
      tokensUsed: 900,
      tokenBudgetSnapshot: snapshot,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'budget_exhausted',
        message: 'Token budget exhausted',
      },
      metadata: {
        turnsCount: 4,
        toolCallsCount: 5,
        duration: 90,
        tokensUsed: 900,
        tokenBudgetSnapshot: snapshot,
      },
    });
  });

  it('builds a diminishing-returns budget result with the stable stop message', () => {
    const snapshot = { consecutiveLowOutputTurns: 3 };
    const result = buildAgentLoopBudgetExhaustedResult({
      reason: 'diminishing_returns',
      turnsCount: 6,
      toolCallsCount: 7,
      startTime: 200,
      now: 260,
      tokensUsed: 1200,
      tokenBudgetSnapshot: snapshot,
    });

    expect(result.error.message).toBe(
      'Stopped due to diminishing returns: consecutive turns produced very few tokens',
    );
    expect(result.metadata).toEqual({
      turnsCount: 6,
      toolCallsCount: 7,
      duration: 60,
      tokensUsed: 1200,
      tokenBudgetSnapshot: snapshot,
    });
  });

  it('builds a successful final response result with usage metadata', () => {
    const snapshot = { usedTokens: 42, maxTokens: 100 };
    const result = buildAgentLoopSuccessResult({
      finalMessage: 'done',
      turnsCount: 3,
      toolCallsCount: 2,
      startTime: 300,
      now: 375,
      tokensUsed: 42,
      tokenBudgetSnapshot: snapshot,
    });

    expect(result).toEqual({
      success: true,
      finalMessage: 'done',
      metadata: {
        turnsCount: 3,
        toolCallsCount: 2,
        duration: 75,
        tokensUsed: 42,
        tokenBudgetSnapshot: snapshot,
      },
    });
  });
});
