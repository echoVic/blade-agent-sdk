import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopAbortCompletion,
  buildAgentLoopAbortCompletionInput,
  buildAgentLoopAbortCompletionInputFromLoopState,
  buildAgentLoopAbortCompletionInputFromTiming,
  buildAgentLoopAbortResult,
  buildAgentLoopBudgetExhaustedResult,
  buildAgentLoopNoToolSuccessDecision,
  buildAgentLoopNoToolSuccessDecisionInput,
  buildAgentLoopNoToolSuccessDecisionInputFromLoopState,
  buildAgentLoopNoToolSuccessDecisionInputFromTiming,
  buildAgentLoopSuccessResult,
  buildAgentLoopToolExitDecision,
  buildAgentLoopToolExitDecisionInput,
  buildAgentLoopToolExitDecisionInputFromLoopState,
  buildAgentLoopToolExitDecisionInputFromTiming,
  buildAgentLoopToolExitFinalMessage,
  buildAgentLoopToolExitResult,
  shouldAbortAgentLoop,
  shouldExitAgentLoopForToolDecision,
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

  it('treats only explicitly aborted signals as loop abort requests', () => {
    expect(shouldAbortAgentLoop()).toBe(false);
    expect(shouldAbortAgentLoop({ aborted: false })).toBe(false);
    expect(shouldAbortAgentLoop({ aborted: true })).toBe(true);
  });

  it('builds abort completion with terminal events and deterministic result metadata', () => {
    expect(
      buildAgentLoopAbortCompletion({
        turnsCount: 2,
        toolCallsCount: 3,
        startTime: 100,
        now: 175,
      }),
    ).toEqual({
      action: 'abort',
      events: [{ type: 'agent_end' }],
      result: {
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
      },
    });
  });

  it('projects abort completion input from loop timing', () => {
    expect(
      buildAgentLoopAbortCompletionInput({
        turnsCount: 2,
        toolCallsCount: 3,
        startTime: 100,
        now: 175,
      }),
    ).toEqual({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
    });
  });

  it('projects abort completion input from an explicit timing payload', () => {
    expect(
      buildAgentLoopAbortCompletionInputFromTiming({
        timing: {
          turnsCount: 2,
          toolCallsCount: 3,
          startTime: 100,
          now: 175,
        },
      }),
    ).toEqual({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
    });
  });

  it('projects abort completion input from loop state objects', () => {
    expect(
      buildAgentLoopAbortCompletionInputFromLoopState({
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 100,
            now: 175,
          }),
        },
        turnsCount: 2,
        toolResultTracker: {
          toolCallsCount: 3,
        },
      }),
    ).toEqual({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
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

  it('builds a no-tool success decision with terminal events and usage metadata', () => {
    const snapshot = { usedTokens: 84, maxTokens: 200 };

    expect(
      buildAgentLoopNoToolSuccessDecision({
        finalMessage: 'finished',
        turnsCount: 4,
        toolCallsCount: 6,
        startTime: 1000,
        now: 1125,
        tokensUsed: 84,
        tokenBudgetSnapshot: snapshot,
      }),
    ).toEqual({
      action: 'finish',
      events: [
        { type: 'turn_end', turn: 4, hasToolCalls: false },
        { type: 'agent_end' },
      ],
      result: {
        success: true,
        finalMessage: 'finished',
        metadata: {
          turnsCount: 4,
          toolCallsCount: 6,
          duration: 125,
          tokensUsed: 84,
          tokenBudgetSnapshot: snapshot,
        },
      },
    });
  });

  it('projects no-tool success decision input from final message and loop usage', () => {
    const snapshot = { usedTokens: 84, maxTokens: 200 };

    expect(
      buildAgentLoopNoToolSuccessDecisionInput({
        finalMessage: 'finished',
        turnsCount: 4,
        toolCallsCount: 6,
        startTime: 1000,
        now: 1125,
        tokensUsed: 84,
        tokenBudgetSnapshot: snapshot,
      }),
    ).toEqual({
      finalMessage: 'finished',
      turnsCount: 4,
      toolCallsCount: 6,
      startTime: 1000,
      now: 1125,
      tokensUsed: 84,
      tokenBudgetSnapshot: snapshot,
    });
  });

  it('projects no-tool success decision input from an explicit timing payload', () => {
    const snapshot = { usedTokens: 84, maxTokens: 200 };

    expect(
      buildAgentLoopNoToolSuccessDecisionInputFromTiming({
        finalMessage: 'finished',
        timing: {
          turnsCount: 4,
          toolCallsCount: 6,
          startTime: 1000,
          now: 1125,
        },
        tokensUsed: 84,
        tokenBudgetSnapshot: snapshot,
      }),
    ).toEqual({
      finalMessage: 'finished',
      turnsCount: 4,
      toolCallsCount: 6,
      startTime: 1000,
      now: 1125,
      tokensUsed: 84,
      tokenBudgetSnapshot: snapshot,
    });
  });

  it('projects no-tool success decision input from loop state objects', () => {
    const snapshot = { usedTokens: 84, maxTokens: 200 };

    expect(
      buildAgentLoopNoToolSuccessDecisionInputFromLoopState({
        finalMessage: 'finished',
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 1000,
            now: 1125,
          }),
        },
        turnsCount: 4,
        toolResultTracker: {
          toolCallsCount: 6,
        },
        tokenUsageTracker: {
          totalTokens: 84,
        },
        tokenBudget: {
          getSnapshot: () => snapshot,
        },
      }),
    ).toEqual({
      finalMessage: 'finished',
      turnsCount: 4,
      toolCallsCount: 6,
      startTime: 1000,
      now: 1125,
      tokensUsed: 84,
      tokenBudgetSnapshot: snapshot,
    });
  });

  it('projects no-tool success decision input without a token budget snapshot', () => {
    expect(
      buildAgentLoopNoToolSuccessDecisionInputFromLoopState({
        finalMessage: undefined,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 2000,
            now: 2050,
          }),
        },
        turnsCount: 1,
        toolResultTracker: {
          toolCallsCount: 0,
        },
        tokenUsageTracker: {
          totalTokens: 12,
        },
      }),
    ).toEqual({
      finalMessage: undefined,
      turnsCount: 1,
      toolCallsCount: 0,
      startTime: 2000,
      now: 2050,
      tokensUsed: 12,
      tokenBudgetSnapshot: undefined,
    });
  });

  it('builds a tool-requested exit result with target mode metadata', () => {
    const result = buildAgentLoopToolExitResult({
      success: true,
      finalMessage: 'approved',
      turnsCount: 5,
      toolCallsCount: 8,
      startTime: 500,
      now: 620,
      targetMode: 'default',
    });

    expect(result).toEqual({
      success: true,
      finalMessage: 'approved',
      metadata: {
        turnsCount: 5,
        toolCallsCount: 8,
        duration: 120,
        shouldExitLoop: true,
        targetMode: 'default',
      },
    });
  });

  it('projects tool-requested exit final messages from tool results', () => {
    expect(buildAgentLoopToolExitFinalMessage({ llmContent: 'approved' })).toBe('approved');
    expect(buildAgentLoopToolExitFinalMessage({ llmContent: { status: 'done' } })).toBe(
      '循环已退出',
    );
    expect(buildAgentLoopToolExitFinalMessage({})).toBe('循环已退出');
  });

  it('continues when a tool result does not request loop exit', () => {
    expect(
      buildAgentLoopToolExitDecision({
        toolCall: {
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
        result: { success: true, llmContent: 'keep going' },
        hasStreamingExecutionResults: false,
        turnsCount: 2,
        toolCallsCount: 3,
        startTime: 100,
        now: 140,
      }),
    ).toEqual({ action: 'continue', events: [] });
  });

  it('builds tool-exit decision input from tool results and non-streaming loop state', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'ExitPlanMode', arguments: '{}' },
    };
    const result = {
      success: true,
      metadata: { shouldExitLoop: true },
    };

    expect(
      buildAgentLoopToolExitDecisionInput({
        toolCall,
        result,
        streamingExecutionResults: undefined,
        turnsCount: 2,
        toolCallsCount: 3,
        startTime: 100,
        now: 140,
      }),
    ).toEqual({
      toolCall,
      result,
      hasStreamingExecutionResults: false,
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 140,
    });
  });

  it('projects tool-exit decision input from an explicit timing payload', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'Exit', arguments: '{}' },
    };
    const result = {
      success: true,
      llmContent: 'approved',
      metadata: { shouldExitLoop: true, targetMode: 'default' },
    };

    expect(
      buildAgentLoopToolExitDecisionInputFromTiming({
        toolCall,
        result,
        streamingExecutionResults: [{ toolCall, result }],
        timing: {
          turnsCount: 5,
          toolCallsCount: 8,
          startTime: 500,
          now: 620,
        },
      }),
    ).toEqual({
      toolCall,
      result,
      hasStreamingExecutionResults: true,
      turnsCount: 5,
      toolCallsCount: 8,
      startTime: 500,
      now: 620,
    });
  });

  it('projects tool-exit decision input from loop state objects', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'Exit', arguments: '{}' },
    };
    const result = {
      success: true,
      llmContent: 'approved',
      metadata: { shouldExitLoop: true, targetMode: 'default' },
    };
    const streamingExecutionResults = [{ toolCall, result }];

    expect(
      buildAgentLoopToolExitDecisionInputFromLoopState({
        toolCall,
        result,
        streamingExecutionResults,
        loopClock: {
          resultTiming: ({ turnsCount, toolCallsCount }) => ({
            turnsCount,
            toolCallsCount,
            startTime: 500,
            now: 620,
          }),
        },
        turnsCount: 5,
        toolResultTracker: {
          toolCallsCount: 8,
        },
      }),
    ).toEqual({
      toolCall,
      result,
      hasStreamingExecutionResults: true,
      turnsCount: 5,
      toolCallsCount: 8,
      startTime: 500,
      now: 620,
    });
  });

  it('marks tool-exit decision input as streaming when results were already emitted', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'ExitPlanMode', arguments: '{}' },
    };
    const result = {
      success: true,
      metadata: { shouldExitLoop: true },
    };

    expect(
      buildAgentLoopToolExitDecisionInput({
        toolCall,
        result,
        streamingExecutionResults: [{ toolCall, result, toolUseUuid: null }],
        turnsCount: 2,
        toolCallsCount: 3,
        startTime: 100,
        now: 140,
      }).hasStreamingExecutionResults,
    ).toBe(true);
  });

  it('exits the loop only for tool-exit decisions', () => {
    expect(shouldExitAgentLoopForToolDecision({ action: 'continue', events: [] })).toBe(false);

    const decision = buildAgentLoopToolExitDecision({
      toolCall: {
        id: 'call_1',
        type: 'function',
        function: { name: 'ExitPlanMode', arguments: '{}' },
      },
      result: {
        success: true,
        llmContent: 'approved',
        metadata: { shouldExitLoop: true },
      },
      hasStreamingExecutionResults: true,
      turnsCount: 3,
      toolCallsCount: 4,
      startTime: 100,
      now: 150,
    });

    expect(shouldExitAgentLoopForToolDecision(decision)).toBe(true);
  });

  it('builds a non-streaming tool exit decision with result and terminal events', () => {
    const toolCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'ExitPlanMode', arguments: '{}' },
    };
    const result = {
      success: true,
      llmContent: 'approved',
      metadata: { shouldExitLoop: true, targetMode: 'default' },
    };

    expect(
      buildAgentLoopToolExitDecision({
        toolCall,
        result,
        hasStreamingExecutionResults: false,
        turnsCount: 5,
        toolCallsCount: 8,
        startTime: 500,
        now: 620,
      }),
    ).toEqual({
      action: 'exit',
      events: [
        { type: 'tool_result', toolCall, result },
        { type: 'turn_end', turn: 5, hasToolCalls: true },
        { type: 'agent_end' },
      ],
      result: {
        success: true,
        finalMessage: 'approved',
        metadata: {
          turnsCount: 5,
          toolCallsCount: 8,
          duration: 120,
          shouldExitLoop: true,
          targetMode: 'default',
        },
      },
    });
  });

  it('omits the duplicate tool_result event for streaming tool exit decisions', () => {
    const decision = buildAgentLoopToolExitDecision({
      toolCall: {
        id: 'call_1',
        type: 'function',
        function: { name: 'ExitPlanMode', arguments: '{}' },
      },
      result: {
        success: false,
        llmContent: { rejected: true },
        metadata: { shouldExitLoop: true },
      },
      hasStreamingExecutionResults: true,
      turnsCount: 1,
      toolCallsCount: 1,
      startTime: 10,
      now: 20,
    });

    expect(decision.action).toBe('exit');
    expect(decision.events.map((event) => event.type)).toEqual(['turn_end', 'agent_end']);
    if (decision.action === 'exit') {
      expect(decision.result.finalMessage).toBe('循环已退出');
    }
  });
});
