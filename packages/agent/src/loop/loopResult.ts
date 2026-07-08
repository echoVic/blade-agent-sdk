import type { AgentFunctionToolCall } from './planToolExecution.js';
import {
  buildAgentLoopEndEvent,
  buildAgentLoopTurnEndEvent,
  type AgentLoopEndEvent,
  type AgentLoopTurnEndEvent,
} from './loopEvents.js';

export interface AgentLoopAbortResult {
  success: false;
  error: {
    type: 'aborted';
    message: string;
  };
  metadata: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
  };
}

export interface AgentLoopBudgetExhaustedResult {
  success: false;
  error: {
    type: 'budget_exhausted';
    message: string;
  };
  metadata: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed: number;
    tokenBudgetSnapshot: unknown;
  };
}

export interface AgentLoopSuccessResult {
  success: true;
  finalMessage: string | undefined;
  metadata: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed: number;
    tokenBudgetSnapshot: unknown;
  };
}

export interface AgentLoopToolExitResult {
  success: boolean;
  finalMessage: string;
  metadata: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    shouldExitLoop: true;
    targetMode: unknown;
  };
}

export interface AgentLoopResultTiming {
  turnsCount: number;
  toolCallsCount: number;
  startTime: number;
  now?: number;
}

export interface AgentLoopAbortCompletionTimingInput {
  timing: AgentLoopResultTiming;
}

export interface AgentLoopAbortCompletionTimingSource {
  resultTiming(input: { turnsCount: number; toolCallsCount: number }): AgentLoopResultTiming;
}

export interface AgentLoopAbortCompletionToolResultTrackerLike {
  readonly toolCallsCount: number;
}

export interface AgentLoopAbortCompletionLoopStateInput {
  loopClock: AgentLoopAbortCompletionTimingSource;
  turnsCount: number;
  toolResultTracker: AgentLoopAbortCompletionToolResultTrackerLike;
}

export interface AgentLoopNoToolSuccessTimingInput {
  finalMessage: string | undefined;
  timing: AgentLoopResultTiming;
  tokensUsed: number;
  tokenBudgetSnapshot: unknown;
}

export interface AgentLoopNoToolSuccessTimingSource {
  resultTiming(input: { turnsCount: number; toolCallsCount: number }): AgentLoopResultTiming;
}

export interface AgentLoopNoToolSuccessToolResultTrackerLike {
  readonly toolCallsCount: number;
}

export interface AgentLoopNoToolSuccessTokenUsageTrackerLike {
  readonly totalTokens: number;
}

export interface AgentLoopNoToolSuccessTokenBudgetLike<TSnapshot = unknown> {
  getSnapshot(): TSnapshot;
}

export interface AgentLoopNoToolSuccessLoopStateInput<TSnapshot = unknown> {
  finalMessage: string | undefined;
  loopClock: AgentLoopNoToolSuccessTimingSource;
  turnsCount: number;
  toolResultTracker: AgentLoopNoToolSuccessToolResultTrackerLike;
  tokenUsageTracker: AgentLoopNoToolSuccessTokenUsageTrackerLike;
  tokenBudget?: AgentLoopNoToolSuccessTokenBudgetLike<TSnapshot>;
}

export interface AgentLoopBudgetExhaustedResultInput extends AgentLoopResultTiming {
  reason: 'exhausted' | 'diminishing_returns';
  tokensUsed: number;
  tokenBudgetSnapshot: unknown;
}

export interface AgentLoopSuccessResultInput extends AgentLoopResultTiming {
  finalMessage: string | undefined;
  tokensUsed: number;
  tokenBudgetSnapshot: unknown;
}

export interface AgentLoopToolExitResultInput extends AgentLoopResultTiming {
  success: boolean;
  finalMessage: string;
  targetMode: unknown;
}

export interface AgentLoopToolExitFinalMessageInput {
  llmContent?: unknown;
}

export interface AgentLoopToolExitDecisionResultLike {
  success: boolean;
  llmContent?: unknown;
  metadata?: {
    shouldExitLoop?: boolean;
    targetMode?: unknown;
  };
}

export interface AgentLoopToolExitDecisionInput<
  TResult extends AgentLoopToolExitDecisionResultLike = AgentLoopToolExitDecisionResultLike,
> extends AgentLoopResultTiming {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  hasStreamingExecutionResults: boolean;
}

export interface BuildAgentLoopToolExitDecisionInputArgs<
  TResult extends AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
> extends AgentLoopResultTiming {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
}

export interface AgentLoopToolExitTimingInput<
  TResult extends AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
  timing: AgentLoopResultTiming;
}

export type AgentLoopToolExitDecisionEvent<TResult = AgentLoopToolExitDecisionResultLike> =
  | {
      type: 'tool_result';
      toolCall: AgentFunctionToolCall;
      result: TResult;
    }
  | AgentLoopTurnEndEvent
  | AgentLoopEndEvent;

export interface AgentLoopAbortCompletion {
  action: 'abort';
  events: [AgentLoopEndEvent];
  result: AgentLoopAbortResult;
}

export type AgentLoopToolExitDecision<TResult = AgentLoopToolExitDecisionResultLike> =
  | {
      action: 'continue';
      events: [];
    }
  | {
      action: 'exit';
      events: AgentLoopToolExitDecisionEvent<TResult>[];
      result: AgentLoopToolExitResult;
    };

export type AgentLoopToolExitDecisionExit<
  TResult = AgentLoopToolExitDecisionResultLike,
> = Extract<AgentLoopToolExitDecision<TResult>, { action: 'exit' }>;

export interface AgentLoopNoToolSuccessDecision {
  action: 'finish';
  events: [AgentLoopTurnEndEvent, AgentLoopEndEvent];
  result: AgentLoopSuccessResult;
}

function getLoopDuration(input: Pick<AgentLoopResultTiming, 'startTime' | 'now'>): number {
  return (input.now ?? Date.now()) - input.startTime;
}

export function shouldAbortAgentLoop(signal?: Pick<AbortSignal, 'aborted'>): boolean {
  return signal?.aborted === true;
}

export function buildAgentLoopAbortResult(input: AgentLoopResultTiming): AgentLoopAbortResult {
  return {
    success: false,
    error: {
      type: 'aborted',
      message: '任务已被用户中止',
    },
    metadata: {
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolCallsCount,
      duration: getLoopDuration(input),
    },
  };
}

export function buildAgentLoopAbortCompletionInput(
  input: AgentLoopResultTiming,
): AgentLoopResultTiming {
  return {
    turnsCount: input.turnsCount,
    toolCallsCount: input.toolCallsCount,
    startTime: input.startTime,
    now: input.now,
  };
}

export function buildAgentLoopAbortCompletionInputFromTiming(
  input: AgentLoopAbortCompletionTimingInput,
): AgentLoopResultTiming {
  return buildAgentLoopAbortCompletionInput(input.timing);
}

export function buildAgentLoopAbortCompletionInputFromLoopState(
  input: AgentLoopAbortCompletionLoopStateInput,
): AgentLoopResultTiming {
  return buildAgentLoopAbortCompletionInputFromTiming({
    timing: input.loopClock.resultTiming({
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolResultTracker.toolCallsCount,
    }),
  });
}

export function buildAgentLoopAbortCompletion(
  input: AgentLoopResultTiming,
): AgentLoopAbortCompletion {
  return {
    action: 'abort',
    events: [buildAgentLoopEndEvent()],
    result: buildAgentLoopAbortResult(input),
  };
}

export function buildAgentLoopSuccessResult(
  input: AgentLoopSuccessResultInput,
): AgentLoopSuccessResult {
  return {
    success: true,
    finalMessage: input.finalMessage,
    metadata: {
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolCallsCount,
      duration: getLoopDuration(input),
      tokensUsed: input.tokensUsed,
      tokenBudgetSnapshot: input.tokenBudgetSnapshot,
    },
  };
}

export function buildAgentLoopNoToolSuccessDecisionInput(
  input: AgentLoopSuccessResultInput,
): AgentLoopSuccessResultInput {
  return {
    finalMessage: input.finalMessage,
    turnsCount: input.turnsCount,
    toolCallsCount: input.toolCallsCount,
    startTime: input.startTime,
    now: input.now,
    tokensUsed: input.tokensUsed,
    tokenBudgetSnapshot: input.tokenBudgetSnapshot,
  };
}

export function buildAgentLoopNoToolSuccessDecisionInputFromTiming(
  input: AgentLoopNoToolSuccessTimingInput,
): AgentLoopSuccessResultInput {
  return buildAgentLoopNoToolSuccessDecisionInput({
    finalMessage: input.finalMessage,
    turnsCount: input.timing.turnsCount,
    toolCallsCount: input.timing.toolCallsCount,
    startTime: input.timing.startTime,
    now: input.timing.now,
    tokensUsed: input.tokensUsed,
    tokenBudgetSnapshot: input.tokenBudgetSnapshot,
  });
}

export function buildAgentLoopNoToolSuccessDecisionInputFromLoopState<TSnapshot = unknown>(
  input: AgentLoopNoToolSuccessLoopStateInput<TSnapshot>,
): AgentLoopSuccessResultInput {
  return buildAgentLoopNoToolSuccessDecisionInputFromTiming({
    finalMessage: input.finalMessage,
    timing: input.loopClock.resultTiming({
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolResultTracker.toolCallsCount,
    }),
    tokensUsed: input.tokenUsageTracker.totalTokens,
    tokenBudgetSnapshot: input.tokenBudget?.getSnapshot(),
  });
}

export function buildAgentLoopNoToolSuccessDecision(
  input: AgentLoopSuccessResultInput,
): AgentLoopNoToolSuccessDecision {
  return {
    action: 'finish',
    events: [
      buildAgentLoopTurnEndEvent({ turn: input.turnsCount, hasToolCalls: false }),
      buildAgentLoopEndEvent(),
    ],
    result: buildAgentLoopSuccessResult(input),
  };
}

export function buildAgentLoopToolExitResult(
  input: AgentLoopToolExitResultInput,
): AgentLoopToolExitResult {
  return {
    success: input.success,
    finalMessage: input.finalMessage,
    metadata: {
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolCallsCount,
      duration: getLoopDuration(input),
      shouldExitLoop: true,
      targetMode: input.targetMode,
    },
  };
}

export function buildAgentLoopToolExitFinalMessage(
  input: AgentLoopToolExitFinalMessageInput,
): string {
  return typeof input.llmContent === 'string' ? input.llmContent : '循环已退出';
}

export function shouldExitAgentLoopForToolDecision<TResult>(
  decision: AgentLoopToolExitDecision<TResult>,
): decision is AgentLoopToolExitDecisionExit<TResult> {
  return decision.action === 'exit';
}

export function buildAgentLoopToolExitDecisionInput<
  TResult extends AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
>(
  input: BuildAgentLoopToolExitDecisionInputArgs<TResult, TStreamingExecutionResult>,
): AgentLoopToolExitDecisionInput<TResult> {
  return {
    toolCall: input.toolCall,
    result: input.result,
    hasStreamingExecutionResults: input.streamingExecutionResults !== undefined,
    turnsCount: input.turnsCount,
    toolCallsCount: input.toolCallsCount,
    startTime: input.startTime,
    now: input.now,
  };
}

export function buildAgentLoopToolExitDecisionInputFromTiming<
  TResult extends AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
>(
  input: AgentLoopToolExitTimingInput<TResult, TStreamingExecutionResult>,
): AgentLoopToolExitDecisionInput<TResult> {
  return buildAgentLoopToolExitDecisionInput({
    toolCall: input.toolCall,
    result: input.result,
    streamingExecutionResults: input.streamingExecutionResults,
    turnsCount: input.timing.turnsCount,
    toolCallsCount: input.timing.toolCallsCount,
    startTime: input.timing.startTime,
    now: input.timing.now,
  });
}

export function buildAgentLoopBudgetExhaustedResult(
  input: AgentLoopBudgetExhaustedResultInput,
): AgentLoopBudgetExhaustedResult {
  return {
    success: false,
    error: {
      type: 'budget_exhausted',
      message: input.reason === 'diminishing_returns'
        ? 'Stopped due to diminishing returns: consecutive turns produced very few tokens'
        : 'Token budget exhausted',
    },
    metadata: {
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolCallsCount,
      duration: getLoopDuration(input),
      tokensUsed: input.tokensUsed,
      tokenBudgetSnapshot: input.tokenBudgetSnapshot,
    },
  };
}

export function buildAgentLoopToolExitDecision<
  TResult extends AgentLoopToolExitDecisionResultLike,
>(
  input: AgentLoopToolExitDecisionInput<TResult>,
): AgentLoopToolExitDecision<TResult> {
  if (!input.result.metadata?.shouldExitLoop) {
    return { action: 'continue', events: [] };
  }

  const events: AgentLoopToolExitDecisionEvent<TResult>[] = [];
  if (!input.hasStreamingExecutionResults) {
    events.push({
      type: 'tool_result',
      toolCall: input.toolCall,
      result: input.result,
    });
  }
  events.push(
    buildAgentLoopTurnEndEvent({ turn: input.turnsCount, hasToolCalls: true }),
    buildAgentLoopEndEvent(),
  );

  return {
    action: 'exit',
    events,
    result: buildAgentLoopToolExitResult({
      success: input.result.success,
      finalMessage: buildAgentLoopToolExitFinalMessage(input.result),
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolCallsCount,
      startTime: input.startTime,
      now: input.now,
      targetMode: input.result.metadata?.targetMode,
    }),
  };
}
