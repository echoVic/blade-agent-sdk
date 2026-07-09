import {
  handleAgentLoopAbortIfRequested,
  type AgentLoopAbortIfRequestedEvent,
  type AgentLoopAbortResult,
  type AgentLoopAbortCompletionTimingSource,
  type AgentLoopAbortCompletionToolResultTrackerLike,
  type AgentLoopAbortCompletionTurnCounterLike,
} from './loopResult.js';
import {
  handleAgentLoopTurnStart,
  runAgentLoopBeforeTurnHook,
  type AgentLoopBeforeTurnHookContainer,
  type AgentLoopBeforeTurnConversationLike,
  type AgentLoopBeforeTurnTokenUsageTrackerLike,
  type AgentLoopTurnCounter,
} from './turnCounter.js';
import {
  buildAgentLoopTurnStateProjectionFromPreparation,
  type AgentLoopTurnStateFields,
  type AgentLoopTurnStateProjection,
} from './turnState.js';
import type { AgentLoopTurnStartEvent } from './loopEvents.js';

export interface HandleAgentLoopTurnEntryInput<
  TMessage,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields,
> {
  signal?: Pick<AbortSignal, 'aborted'>;
  loopClock: AgentLoopAbortCompletionTimingSource;
  turnCounter: Pick<
    AgentLoopTurnCounter,
    'beginTurn' | 'shouldRunBeforeTurn'
  > & AgentLoopAbortCompletionTurnCounterLike;
  effectiveMaxTurns: number;
  toolResultTracker: AgentLoopAbortCompletionToolResultTrackerLike;
  conversation: AgentLoopBeforeTurnConversationLike<TMessage>;
  tokenUsageTracker: AgentLoopBeforeTurnTokenUsageTrackerLike;
  hooks?: AgentLoopBeforeTurnHookContainer<TMessage, TEvent, TBeforeTurnReturn> | null;
  prepareTurnState(turn: number): TTurnState;
}

export type AgentLoopTurnEntryEvent<TEvent> =
  | AgentLoopAbortIfRequestedEvent
  | TEvent
  | AgentLoopTurnStartEvent;

export type AgentLoopTurnEntryHandling<TTurnState extends AgentLoopTurnStateFields> =
  | {
      action: 'abort';
      result: AgentLoopAbortResult;
    }
  | {
      action: 'continue';
      turnsCount: number;
      turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
    };

export async function* handleAgentLoopTurnEntryWithEmissions<
  TMessage,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >,
): AsyncGenerator<
  AgentLoopTurnEntryEvent<TEvent>,
  AgentLoopTurnEntryHandling<TTurnState>
> {
  const abortBeforeTurn = yield* handleAgentLoopAbortIfRequested({
    kind: 'counter_state',
    signal: input.signal,
    loopClock: input.loopClock,
    turnCounter: input.turnCounter,
    turnCountSource: 'current',
    toolResultTracker: input.toolResultTracker,
  });
  if (abortBeforeTurn.action === 'abort') {
    return abortBeforeTurn;
  }

  yield* runAgentLoopBeforeTurnHook({
    counter: input.turnCounter,
    conversation: input.conversation,
    tokenUsageTracker: input.tokenUsageTracker,
    hooks: input.hooks,
  });

  const turnStart = handleAgentLoopTurnStart({
    counter: input.turnCounter,
    maxTurns: input.effectiveMaxTurns,
  });
  for (const event of turnStart.events) {
    yield event;
  }

  const abortAfterTurnStart = yield* handleAgentLoopAbortIfRequested({
    kind: 'counter_state',
    signal: input.signal,
    loopClock: input.loopClock,
    turnCounter: input.turnCounter,
    turnCountSource: 'previous_completed',
    toolResultTracker: input.toolResultTracker,
  });
  if (abortAfterTurnStart.action === 'abort') {
    return abortAfterTurnStart;
  }

  return {
    action: 'continue',
    turnsCount: turnStart.turn,
    turnStateProjection: buildAgentLoopTurnStateProjectionFromPreparation({
      prepareTurnState: input.prepareTurnState,
      turn: turnStart.turn,
    }),
  };
}
