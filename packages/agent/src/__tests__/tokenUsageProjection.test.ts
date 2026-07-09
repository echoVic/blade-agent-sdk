import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentLoopTokenBudget,
  buildAgentLoopBudgetWarningEvent,
  buildAgentLoopTokenBudgetInput,
  buildAgentLoopTokenBudgetInputFromLoopState,
  buildAgentLoopTokenBudgetInputFromTiming,
  buildAgentLoopTokenBudgetStopCompletion,
  buildAgentLoopTokenUsageEvent,
  buildAgentLoopTokenUsageInfo,
  buildAgentLoopTokenUsageInfoInput,
  buildAgentLoopTokenUsageInfoInputFromLoopState,
  buildAgentLoopTokenUsageInfoInputFromTurnProjection,
  emitAgentLoopTokenUsageEventIfPresent,
  handleAgentLoopTokenBudgetCheck,
  runAgentLoopTokenBudgetCheck,
  shouldStopAgentLoopForTokenBudget,
  shouldStopAgentLoopForTokenBudgetCheck,
  type AgentLoopTokenBudgetStopDecision,
} from '../loop/tokenUsage.js';

async function collectGenerator<TEvent, TResult>(
  generator: AsyncGenerator<TEvent, TResult>,
): Promise<{ events: TEvent[]; result: TResult }> {
  const events: TEvent[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

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

  it('projects token usage info input from a turn state projection', () => {
    const modelUsage = {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    };
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'default' as const,
    };

    expect(
      buildAgentLoopTokenUsageInfoInputFromTurnProjection({
        modelUsage,
        totalTokens: 40,
        turnStateProjection: {
          turnState,
          maxContextTokens: turnState.maxContextTokens,
          executionContext: turnState.executionContext,
          permissionMode: turnState.permissionMode,
        },
      }),
    ).toEqual({
      modelUsage,
      totalTokens: 40,
      maxContextTokens: 128000,
    });
  });

  it('projects token usage info input from loop state objects', () => {
    const modelUsage = {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    };
    const turnState = {
      maxContextTokens: 128000,
      executionContext: { cwd: '/tmp/project' },
      permissionMode: 'default' as const,
    };

    expect(
      buildAgentLoopTokenUsageInfoInputFromLoopState({
        modelUsage,
        tokenUsageTracker: {
          totalTokens: 40,
        },
        turnStateProjection: {
          turnState,
          maxContextTokens: turnState.maxContextTokens,
          executionContext: turnState.executionContext,
          permissionMode: turnState.permissionMode,
        },
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

  it('records model usage and emits the accumulated token usage event', async () => {
    const recordedUsages: unknown[] = [];
    const tokenUsageTracker = {
      totalTokens: 0,
      record(usage: unknown) {
        recordedUsages.push(usage);
        this.totalTokens += 12;
      },
    };
    const modelUsage = {
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    };

    const usageStream = emitAgentLoopTokenUsageEventIfPresent({
      modelUsage,
      tokenUsageTracker,
      turnStateProjection: {
        turnState: {
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default' as const,
        },
        maxContextTokens: 128000,
        executionContext: { cwd: '/tmp/project' },
        permissionMode: 'default' as const,
      },
    });

    await expect(usageStream.next()).resolves.toEqual({
      value: {
        type: 'token_usage',
        usage: {
          inputTokens: 9,
          outputTokens: 3,
          totalTokens: 12,
          maxContextTokens: 128000,
          cacheReadInputTokens: undefined,
          cacheMissInputTokens: undefined,
          billableInputTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      done: false,
    });
    await expect(usageStream.next()).resolves.toEqual({
      value: {
        type: 'token_usage',
        usage: {
          inputTokens: 9,
          outputTokens: 3,
          totalTokens: 12,
          maxContextTokens: 128000,
          cacheReadInputTokens: undefined,
          cacheMissInputTokens: undefined,
          billableInputTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      done: true,
    });
    expect(recordedUsages).toEqual([modelUsage]);
  });

  it('does not record or emit token usage when model usage is missing', async () => {
    const tokenUsageTracker = {
      totalTokens: 40,
      record: vi.fn(),
    };

    const usageStream = emitAgentLoopTokenUsageEventIfPresent({
      modelUsage: undefined,
      tokenUsageTracker,
      turnStateProjection: {
        turnState: {
          maxContextTokens: 128000,
          executionContext: { cwd: '/tmp/project' },
          permissionMode: 'default' as const,
        },
        maxContextTokens: 128000,
        executionContext: { cwd: '/tmp/project' },
        permissionMode: 'default' as const,
      },
    });

    await expect(usageStream.next()).resolves.toEqual({
      value: null,
      done: true,
    });
    expect(tokenUsageTracker.record).not.toHaveBeenCalled();
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

  it('projects token budget handling input from usage and loop timing', () => {
    const usage = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
    const snapshot = { totalTokens: 92 };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => false),
      isDiminishingReturns: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(() => snapshot),
    };

    expect(
      buildAgentLoopTokenBudgetInput({
        tokenBudget,
        modelUsage: usage,
        tokensUsed: 92,
        turnsCount: 2,
        toolCallsCount: 4,
        startTime: 100,
        now: 140,
      }),
    ).toEqual({
      tokenBudget,
      modelUsage: usage,
      tokensUsed: 92,
      turnsCount: 2,
      toolCallsCount: 4,
      startTime: 100,
      now: 140,
    });
  });

  it('projects token budget handling input from an explicit timing payload', () => {
    const usage = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
    const snapshot = { totalTokens: 92 };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => false),
      isDiminishingReturns: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(() => snapshot),
    };

    expect(
      buildAgentLoopTokenBudgetInputFromTiming({
        tokenBudget,
        modelUsage: usage,
        tokensUsed: 92,
        timing: {
          turnsCount: 2,
          toolCallsCount: 4,
          startTime: 100,
          now: 140,
        },
      }),
    ).toEqual({
      tokenBudget,
      modelUsage: usage,
      tokensUsed: 92,
      turnsCount: 2,
      toolCallsCount: 4,
      startTime: 100,
      now: 140,
    });
  });

  it('projects token budget handling input from loop state objects', () => {
    const usage = { promptTokens: 9, completionTokens: 3, totalTokens: 12 };
    const snapshot = { totalTokens: 92 };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => false),
      isDiminishingReturns: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(() => snapshot),
    };

    expect(
      buildAgentLoopTokenBudgetInputFromLoopState({
        tokenBudget,
        modelUsage: usage,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 100,
            now: 140,
          }),
        },
        turnsCount: 2,
        toolResultTracker: {
          toolCallsCount: 4,
        },
        tokenUsageTracker: {
          totalTokens: 92,
        },
      }),
    ).toEqual({
      tokenBudget,
      modelUsage: usage,
      tokensUsed: 92,
      turnsCount: 2,
      toolCallsCount: 4,
      startTime: 100,
      now: 140,
    });
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

  it('runs token budget checks from loop state and returns warning continuations', async () => {
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

    const check = await runAgentLoopTokenBudgetCheck({
      tokenBudget,
      modelUsage: usage,
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => ({
          turnsCount,
          toolCallsCount,
          startTime: 100,
          now: 140,
        }),
      },
      turnsCount: 2,
      toolResultTracker: {
        toolCallsCount: 4,
      },
      tokenUsageTracker: {
        totalTokens: 92,
      },
    });

    expect(check).toEqual({
      action: 'continue',
      events: [{ type: 'budget_warning', snapshot }],
    });
    expect(shouldStopAgentLoopForTokenBudgetCheck(check)).toBe(false);
    expect(tokenBudget.record).toHaveBeenCalledWith(usage);
  });

  it('handles token budget checks by yielding warning events and continuing', async () => {
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

    const handled = await collectGenerator(
      handleAgentLoopTokenBudgetCheck({
        tokenBudget,
        modelUsage: usage,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 100,
            now: 140,
          }),
        },
        turnsCount: 2,
        toolResultTracker: {
          toolCallsCount: 4,
        },
        tokenUsageTracker: {
          totalTokens: 92,
        },
      }),
    );

    expect(handled).toEqual({
      events: [{ type: 'budget_warning', snapshot }],
      result: { action: 'continue' },
    });
    expect(tokenBudget.record).toHaveBeenCalledWith(usage);
  });

  it('runs token budget checks from loop state and returns stop completions', async () => {
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

    const check = await runAgentLoopTokenBudgetCheck({
      tokenBudget,
      modelUsage: { completionTokens: 1, totalTokens: 1 },
      loopClock: {
        resultTiming: ({ turnsCount, toolCallsCount }) => ({
          turnsCount,
          toolCallsCount,
          startTime: 100,
          now: 140,
        }),
      },
      turnsCount: 3,
      toolResultTracker: {
        toolCallsCount: 7,
      },
      tokenUsageTracker: {
        totalTokens: 95,
      },
    });

    expect(shouldStopAgentLoopForTokenBudgetCheck(check)).toBe(true);
    expect(check).toEqual({
      action: 'stop',
      events: [
        { type: 'budget_warning', snapshot: warningSnapshot },
        { type: 'agent_end' },
      ],
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

  it('handles token budget checks by yielding terminal stop events and returning the stop result', async () => {
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

    const handled = await collectGenerator(
      handleAgentLoopTokenBudgetCheck({
        tokenBudget,
        modelUsage: { completionTokens: 1, totalTokens: 1 },
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 100,
            now: 140,
          }),
        },
        turnsCount: 3,
        toolResultTracker: {
          toolCallsCount: 7,
        },
        tokenUsageTracker: {
          totalTokens: 95,
        },
      }),
    );

    expect(handled).toEqual({
      events: [
        { type: 'budget_warning', snapshot: warningSnapshot },
        { type: 'agent_end' },
      ],
      result: {
        action: 'stop',
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
      },
    });
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
