import type { ModelUsageInfo } from '@blade-ai/ai';
import {
  buildAgentLoopEndEvent,
  type AgentLoopEndEvent,
} from './loopEvents.js';
import {
  buildAgentLoopBudgetExhaustedResult,
  type AgentLoopBudgetExhaustedResult,
  type AgentLoopResultTiming,
} from './loopResult.js';
import type {
  AgentLoopTurnStateFields,
  AgentLoopTurnStateProjection,
} from './turnState.js';
import {
  recordAgentLoopTokenUsage,
  shouldRecordAgentLoopTokenUsage,
  type AgentLoopTokenUsageRecord,
} from './tokenUsageTracker.js';

export interface AgentLoopTokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
  reasoningTokens?: number;
}

export interface AgentLoopTokenUsageEvent {
  type: 'token_usage';
  usage: AgentLoopTokenUsageInfo;
}

export interface AgentLoopTokenUsageEventInput {
  usage: AgentLoopTokenUsageInfo;
}

export interface AgentLoopBudgetWarningEvent<TSnapshot = unknown> {
  type: 'budget_warning';
  snapshot: TSnapshot;
}

export interface AgentLoopBudgetWarningEventInput<TSnapshot = unknown> {
  snapshot: TSnapshot;
}

export interface BuildAgentLoopTokenUsageInfoInput {
  modelUsage: ModelUsageInfo;
  totalTokens: number;
  maxContextTokens: number;
}

export interface BuildAgentLoopTokenUsageInfoTurnProjectionInput<
  TTurnState extends AgentLoopTurnStateFields,
> {
  modelUsage: ModelUsageInfo;
  totalTokens: number;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
}

export interface AgentLoopTokenUsageInfoTokenUsageTrackerLike {
  readonly totalTokens: number;
}

export interface BuildAgentLoopTokenUsageInfoLoopStateInput<
  TTurnState extends AgentLoopTurnStateFields,
> {
  modelUsage: ModelUsageInfo;
  tokenUsageTracker: AgentLoopTokenUsageInfoTokenUsageTrackerLike;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
}

export interface AgentLoopTokenUsageEventTokenUsageTrackerLike
  extends AgentLoopTokenUsageInfoTokenUsageTrackerLike {
  record(usage: AgentLoopTokenUsageRecord): void;
}

export interface EmitAgentLoopTokenUsageEventIfPresentInput<
  TTurnState extends AgentLoopTurnStateFields,
> {
  modelUsage?: ModelUsageInfo;
  tokenUsageTracker: AgentLoopTokenUsageEventTokenUsageTrackerLike;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
}

export interface AgentLoopTokenBudgetLike<TSnapshot = unknown> {
  record(usage: ModelUsageInfo): Promise<void> | void;
  isWarning(): boolean;
  isApproachingLimit(): boolean;
  isDiminishingReturns?(): boolean;
  isExhausted(): boolean;
  getSnapshot(): TSnapshot;
}

export interface ApplyAgentLoopTokenBudgetInput<TSnapshot = unknown>
  extends AgentLoopResultTiming {
  tokenBudget?: AgentLoopTokenBudgetLike<TSnapshot>;
  modelUsage?: ModelUsageInfo;
  tokensUsed: number;
}

export interface AgentLoopTokenBudgetTimingInput<TSnapshot = unknown> {
  tokenBudget?: AgentLoopTokenBudgetLike<TSnapshot>;
  modelUsage?: ModelUsageInfo;
  tokensUsed: number;
  timing: AgentLoopResultTiming;
}

export interface AgentLoopTokenBudgetTimingSource {
  resultTiming(input: { turnsCount: number; toolCallsCount: number }): AgentLoopResultTiming;
}

export interface AgentLoopTokenBudgetToolResultTrackerLike {
  readonly toolCallsCount: number;
}

export interface AgentLoopTokenBudgetTokenUsageTrackerLike {
  readonly totalTokens: number;
}

export interface AgentLoopTokenBudgetLoopStateInput<TSnapshot = unknown> {
  tokenBudget?: AgentLoopTokenBudgetLike<TSnapshot>;
  modelUsage?: ModelUsageInfo;
  loopClock: AgentLoopTokenBudgetTimingSource;
  turnsCount: number;
  toolResultTracker: AgentLoopTokenBudgetToolResultTrackerLike;
  tokenUsageTracker: AgentLoopTokenBudgetTokenUsageTrackerLike;
}

export interface ApplyAgentLoopTokenBudgetResult<TSnapshot = unknown> {
  events: AgentLoopBudgetWarningEvent<TSnapshot>[];
  result?: AgentLoopBudgetExhaustedResult;
}

export interface AgentLoopTokenBudgetStopDecision<TSnapshot = unknown>
  extends ApplyAgentLoopTokenBudgetResult<TSnapshot> {
  result: AgentLoopBudgetExhaustedResult;
}

export interface AgentLoopTokenBudgetStopCompletion<TSnapshot = unknown> {
  action: 'stop';
  events: [...AgentLoopBudgetWarningEvent<TSnapshot>[], AgentLoopEndEvent];
  result: AgentLoopBudgetExhaustedResult;
}

export interface AgentLoopTokenBudgetContinueCompletion<TSnapshot = unknown> {
  action: 'continue';
  events: AgentLoopBudgetWarningEvent<TSnapshot>[];
}

export type AgentLoopTokenBudgetCheckResult<TSnapshot = unknown> =
  | AgentLoopTokenBudgetContinueCompletion<TSnapshot>
  | AgentLoopTokenBudgetStopCompletion<TSnapshot>;

export type AgentLoopTokenBudgetCheckEvent<TSnapshot = unknown> =
  | AgentLoopBudgetWarningEvent<TSnapshot>
  | AgentLoopEndEvent;

export type AgentLoopTokenBudgetCheckHandling =
  | {
      action: 'continue';
    }
  | {
      action: 'stop';
      result: AgentLoopBudgetExhaustedResult;
    };

export function buildAgentLoopTokenUsageInfo(
  input: BuildAgentLoopTokenUsageInfoInput,
): AgentLoopTokenUsageInfo {
  return {
    inputTokens: input.modelUsage.promptTokens ?? 0,
    outputTokens: input.modelUsage.completionTokens ?? 0,
    totalTokens: input.totalTokens,
    maxContextTokens: input.maxContextTokens,
    cacheReadInputTokens: input.modelUsage.cacheReadInputTokens,
    cacheMissInputTokens: input.modelUsage.cacheMissInputTokens,
    billableInputTokens: input.modelUsage.billableInputTokens,
    reasoningTokens: input.modelUsage.reasoningTokens,
  };
}

export function buildAgentLoopTokenUsageInfoInput(
  input: BuildAgentLoopTokenUsageInfoInput,
): BuildAgentLoopTokenUsageInfoInput {
  return {
    modelUsage: input.modelUsage,
    totalTokens: input.totalTokens,
    maxContextTokens: input.maxContextTokens,
  };
}

export function buildAgentLoopTokenUsageInfoInputFromTurnProjection<
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: BuildAgentLoopTokenUsageInfoTurnProjectionInput<TTurnState>,
): BuildAgentLoopTokenUsageInfoInput {
  return buildAgentLoopTokenUsageInfoInput({
    modelUsage: input.modelUsage,
    totalTokens: input.totalTokens,
    maxContextTokens: input.turnStateProjection.maxContextTokens,
  });
}

export function buildAgentLoopTokenUsageInfoInputFromLoopState<
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: BuildAgentLoopTokenUsageInfoLoopStateInput<TTurnState>,
): BuildAgentLoopTokenUsageInfoInput {
  return buildAgentLoopTokenUsageInfoInputFromTurnProjection({
    modelUsage: input.modelUsage,
    totalTokens: input.tokenUsageTracker.totalTokens,
    turnStateProjection: input.turnStateProjection,
  });
}

export function buildAgentLoopTokenUsageEvent(
  input: AgentLoopTokenUsageEventInput,
): AgentLoopTokenUsageEvent {
  return {
    type: 'token_usage',
    usage: input.usage,
  };
}

export async function* emitAgentLoopTokenUsageEventIfPresent<
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: EmitAgentLoopTokenUsageEventIfPresentInput<TTurnState>,
): AsyncGenerator<AgentLoopTokenUsageEvent, AgentLoopTokenUsageEvent | null> {
  if (!shouldRecordAgentLoopTokenUsage(input.modelUsage)) {
    return null;
  }

  recordAgentLoopTokenUsage({
    tracker: input.tokenUsageTracker,
    usage: input.modelUsage,
  });
  const event = buildAgentLoopTokenUsageEvent({
    usage: buildAgentLoopTokenUsageInfo(
      buildAgentLoopTokenUsageInfoInputFromLoopState({
        modelUsage: input.modelUsage,
        tokenUsageTracker: input.tokenUsageTracker,
        turnStateProjection: input.turnStateProjection,
      }),
    ),
  });

  yield event;
  return event;
}

export function buildAgentLoopBudgetWarningEvent<TSnapshot>(
  input: AgentLoopBudgetWarningEventInput<TSnapshot>,
): AgentLoopBudgetWarningEvent<TSnapshot> {
  return {
    type: 'budget_warning',
    snapshot: input.snapshot,
  };
}

export function buildAgentLoopTokenBudgetInput<TSnapshot>(
  input: ApplyAgentLoopTokenBudgetInput<TSnapshot>,
): ApplyAgentLoopTokenBudgetInput<TSnapshot> {
  return {
    tokenBudget: input.tokenBudget,
    modelUsage: input.modelUsage,
    tokensUsed: input.tokensUsed,
    turnsCount: input.turnsCount,
    toolCallsCount: input.toolCallsCount,
    startTime: input.startTime,
    now: input.now,
  };
}

export function buildAgentLoopTokenBudgetInputFromTiming<TSnapshot>(
  input: AgentLoopTokenBudgetTimingInput<TSnapshot>,
): ApplyAgentLoopTokenBudgetInput<TSnapshot> {
  return buildAgentLoopTokenBudgetInput({
    tokenBudget: input.tokenBudget,
    modelUsage: input.modelUsage,
    tokensUsed: input.tokensUsed,
    turnsCount: input.timing.turnsCount,
    toolCallsCount: input.timing.toolCallsCount,
    startTime: input.timing.startTime,
    now: input.timing.now,
  });
}

export function buildAgentLoopTokenBudgetInputFromLoopState<TSnapshot>(
  input: AgentLoopTokenBudgetLoopStateInput<TSnapshot>,
): ApplyAgentLoopTokenBudgetInput<TSnapshot> {
  return buildAgentLoopTokenBudgetInputFromTiming({
    tokenBudget: input.tokenBudget,
    modelUsage: input.modelUsage,
    tokensUsed: input.tokenUsageTracker.totalTokens,
    timing: input.loopClock.resultTiming({
      turnsCount: input.turnsCount,
      toolCallsCount: input.toolResultTracker.toolCallsCount,
    }),
  });
}

export function shouldStopAgentLoopForTokenBudget<TSnapshot>(
  decision: ApplyAgentLoopTokenBudgetResult<TSnapshot>,
): decision is AgentLoopTokenBudgetStopDecision<TSnapshot> {
  return decision.result !== undefined;
}

export function buildAgentLoopTokenBudgetStopCompletion<TSnapshot>(
  decision: AgentLoopTokenBudgetStopDecision<TSnapshot>,
): AgentLoopTokenBudgetStopCompletion<TSnapshot> {
  return {
    action: 'stop',
    events: [...decision.events, buildAgentLoopEndEvent()],
    result: decision.result,
  };
}

export function shouldStopAgentLoopForTokenBudgetCheck<TSnapshot>(
  result: AgentLoopTokenBudgetCheckResult<TSnapshot>,
): result is AgentLoopTokenBudgetStopCompletion<TSnapshot> {
  return result.action === 'stop';
}

export async function runAgentLoopTokenBudgetCheck<TSnapshot>(
  input: AgentLoopTokenBudgetLoopStateInput<TSnapshot>,
): Promise<AgentLoopTokenBudgetCheckResult<TSnapshot>> {
  const decision = await applyAgentLoopTokenBudget(
    buildAgentLoopTokenBudgetInputFromLoopState(input),
  );
  if (shouldStopAgentLoopForTokenBudget(decision)) {
    return buildAgentLoopTokenBudgetStopCompletion(decision);
  }

  return {
    action: 'continue',
    events: decision.events,
  };
}

export async function* handleAgentLoopTokenBudgetCheck<TSnapshot>(
  input: AgentLoopTokenBudgetLoopStateInput<TSnapshot>,
): AsyncGenerator<
  AgentLoopTokenBudgetCheckEvent<TSnapshot>,
  AgentLoopTokenBudgetCheckHandling
> {
  const budgetCheck = await runAgentLoopTokenBudgetCheck(input);
  for (const event of budgetCheck.events) {
    yield event;
  }

  if (shouldStopAgentLoopForTokenBudgetCheck(budgetCheck)) {
    return {
      action: 'stop',
      result: budgetCheck.result,
    };
  }

  return { action: 'continue' };
}

export async function applyAgentLoopTokenBudget<TSnapshot>(
  input: ApplyAgentLoopTokenBudgetInput<TSnapshot>,
): Promise<ApplyAgentLoopTokenBudgetResult<TSnapshot>> {
  const { tokenBudget, modelUsage } = input;
  if (!tokenBudget || !modelUsage) {
    return { events: [] };
  }

  await tokenBudget.record(modelUsage);

  const events: AgentLoopBudgetWarningEvent<TSnapshot>[] = [];
  if (tokenBudget.isWarning() || tokenBudget.isApproachingLimit()) {
    events.push(buildAgentLoopBudgetWarningEvent({ snapshot: tokenBudget.getSnapshot() }));
  }

  if (tokenBudget.isDiminishingReturns?.()) {
    return {
      events,
      result: buildAgentLoopBudgetExhaustedResult({
        reason: 'diminishing_returns',
        turnsCount: input.turnsCount,
        toolCallsCount: input.toolCallsCount,
        startTime: input.startTime,
        now: input.now,
        tokensUsed: input.tokensUsed,
        tokenBudgetSnapshot: tokenBudget.getSnapshot(),
      }),
    };
  }

  if (tokenBudget.isExhausted()) {
    return {
      events,
      result: buildAgentLoopBudgetExhaustedResult({
        reason: 'exhausted',
        turnsCount: input.turnsCount,
        toolCallsCount: input.toolCallsCount,
        startTime: input.startTime,
        now: input.now,
        tokensUsed: input.tokensUsed,
        tokenBudgetSnapshot: tokenBudget.getSnapshot(),
      }),
    };
  }

  return { events };
}
