import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import {
  applyAgentLoopReactiveCompactRetry,
  type AgentLoopTurnCounter,
} from '../loop/turnCounter.js';
import type { AgentLoopTurnRetryEvent } from '../loop/loopEvents.js';
import { assertAgentLoopTurnResponse } from '../loop/assistantMessage.js';
import {
  buildAgentRecoveryCompactStreamFromHookContainer,
  buildAgentRecoveryExhaustedEffects,
  buildAgentRecoveryResetEffects,
  buildAgentRecoveryStartedEffects,
  consumeAgentRecoveryCompactStreamWithEmittedResultEffects,
  emitAgentRecoveryEffects,
  hasAgentReactiveCompactHook,
  handleAgentModelFallbackWithEmissions,
  type AgentRecoveryEffects,
  type AgentRecoveryCompactResultEffects,
  type AgentRecoveryEvent,
  type AgentRecoveryExhaustedEffectsInput,
  type AgentModelFallbackEvent,
  type AgentReactiveCompactConversationLike,
  type AgentReactiveCompactHookContainer,
  type AgentRecoveryStateChangeHookContainer,
} from './recoveryEvents.js';

export interface AgentRecoveryAttemptTracker {
  readonly attempt: number;
  canAttempt(turn: number): boolean;
  hasAttemptedTurn(turn: number): boolean;
  startAttempt(turn: number): number;
  consumeResetAttempt(): number | null;
}

export interface AgentRecoveryExhaustedProjectionInputFromTrackerInput {
  tracker: Pick<AgentRecoveryAttemptTracker, 'attempt'>;
  turn: number;
}

export interface EmitAgentRecoveryExhaustedEffectsFromTrackerInput
  extends AgentRecoveryExhaustedProjectionInputFromTrackerInput {
  hooks?: AgentRecoveryStateChangeHookContainer | null;
}

export interface EmitAgentRecoveryExhaustedEffectsIfAttemptedInput
  extends EmitAgentRecoveryExhaustedEffectsFromTrackerInput {
  error: unknown;
  tracker: Pick<AgentRecoveryAttemptTracker, 'attempt' | 'hasAttemptedTurn'>;
}

export interface StartAgentRecoveryAttemptInput {
  tracker: Pick<AgentRecoveryAttemptTracker, 'startAttempt'>;
  turn: number;
}

export interface StartedAgentRecoveryAttempt {
  attempt: number;
  effects: AgentRecoveryEffects;
}

export interface StartAgentRecoveryAttemptWithCompactStreamInput<TMessage, Event>
  extends StartAgentRecoveryAttemptInput {
  conversation: AgentReactiveCompactConversationLike<TMessage>;
  hooks?: AgentReactiveCompactHookContainer<TMessage, Event> | null;
}

export interface StartAgentRecoveryAttemptWithEmittedCompactStreamInput<TMessage, Event>
  extends StartAgentRecoveryAttemptInput {
  conversation: AgentReactiveCompactConversationLike<TMessage>;
  hooks?:
    | (AgentReactiveCompactHookContainer<TMessage, Event> &
        AgentRecoveryStateChangeHookContainer)
    | null;
}

export interface StartedAgentRecoveryCompactAttempt<Event>
  extends StartedAgentRecoveryAttempt {
  compactStream?: AsyncGenerator<Event, boolean | undefined>;
}

export interface AgentRecoveryCompactAttemptEmissionsResult {
  attempt: number;
  recovered: boolean;
  startedEffects: AgentRecoveryEffects;
  compactResultEffects?: AgentRecoveryCompactResultEffects;
}

export interface ConsumeAgentRecoveryResetEffectsInput {
  tracker: Pick<AgentRecoveryAttemptTracker, 'consumeResetAttempt'>;
  turn: number;
}

export interface EmitAgentRecoveryResetEffectsInput
  extends ConsumeAgentRecoveryResetEffectsInput {
  hooks?: AgentRecoveryStateChangeHookContainer | null;
}

export interface ShouldAttemptAgentRecoveryFromHookContainerInput<TMessage, Event> {
  error: unknown;
  hooks?: AgentReactiveCompactHookContainer<TMessage, Event> | null;
  tracker: Pick<AgentRecoveryAttemptTracker, 'canAttempt'>;
  turn: number;
}

export interface AgentReactiveCompactRecoveryEpochLike {
  invalidate(): void;
}

export interface HandleAgentReactiveCompactRecoveryWithEmissionsInput<
  TMessage,
  Event,
> {
  error: unknown;
  hooks?:
    | (AgentReactiveCompactHookContainer<TMessage, Event> &
        AgentRecoveryStateChangeHookContainer)
    | null;
  tracker: Pick<AgentRecoveryAttemptTracker, 'canAttempt' | 'startAttempt'>;
  turn: number;
  conversation: AgentReactiveCompactConversationLike<TMessage>;
  counter: Pick<AgentLoopTurnCounter, 'requestRetry'>;
  epoch?: AgentReactiveCompactRecoveryEpochLike | null;
}

export type AgentReactiveCompactRecoveryHandling =
  | {
      action: 'unhandled';
    }
  | {
      action: 'failed';
    }
  | {
      action: 'retry';
    };

export interface HandleAgentRunTurnErrorWithEmissionsInput<TMessage, Event>
  extends HandleAgentReactiveCompactRecoveryWithEmissionsInput<TMessage, Event> {
  tracker: Pick<
    AgentRecoveryAttemptTracker,
    'attempt' | 'canAttempt' | 'hasAttemptedTurn' | 'startAttempt'
  >;
}

export interface AgentRunTurnErrorHandling {
  action: 'retry';
}

export interface HandleAgentRunTurnSuccessWithEmissionsInput<TResponse>
  extends EmitAgentRecoveryResetEffectsInput {
  response: TResponse | undefined;
}

export function createAgentRecoveryAttemptTracker(): AgentRecoveryAttemptTracker {
  let attemptedTurn: number | null = null;
  let attempt = 0;

  return {
    get attempt() {
      return attempt;
    },
    canAttempt(turn: number): boolean {
      return attemptedTurn !== turn;
    },
    hasAttemptedTurn(turn: number): boolean {
      return attemptedTurn === turn;
    },
    startAttempt(turn: number): number {
      if (attemptedTurn === turn && attempt > 0) {
        return attempt;
      }

      attemptedTurn = turn;
      attempt += 1;
      return attempt;
    },
    consumeResetAttempt(): number | null {
      if (attempt === 0) {
        return null;
      }

      const previousAttempt = attempt;
      attemptedTurn = null;
      attempt = 0;
      return previousAttempt;
    },
  };
}

export function consumeAgentRecoveryResetAttempt(
  tracker: Pick<AgentRecoveryAttemptTracker, 'consumeResetAttempt'>,
): boolean {
  return tracker.consumeResetAttempt() !== null;
}

export function consumeAgentRecoveryResetEffects(
  input: ConsumeAgentRecoveryResetEffectsInput,
): AgentRecoveryEffects | null {
  return consumeAgentRecoveryResetAttempt(input.tracker)
    ? buildAgentRecoveryResetEffects({ turn: input.turn })
    : null;
}

export async function* emitAgentRecoveryResetEffects(
  input: EmitAgentRecoveryResetEffectsInput,
): AsyncGenerator<AgentRecoveryEvent, AgentRecoveryEffects | null> {
  const effects = consumeAgentRecoveryResetEffects(input);
  if (!effects) {
    return null;
  }

  return yield* emitAgentRecoveryEffects({
    effects,
    hooks: input.hooks,
  });
}

export function startAgentRecoveryAttempt(input: StartAgentRecoveryAttemptInput): number {
  return input.tracker.startAttempt(input.turn);
}

export function startAgentRecoveryAttemptWithStartedEffects(
  input: StartAgentRecoveryAttemptInput,
): StartedAgentRecoveryAttempt {
  const attempt = startAgentRecoveryAttempt(input);
  return {
    attempt,
    effects: buildAgentRecoveryStartedEffects({
      turn: input.turn,
      attempt,
    }),
  };
}

export function startAgentRecoveryAttemptWithCompactStream<TMessage, Event>(
  input: StartAgentRecoveryAttemptWithCompactStreamInput<TMessage, Event>,
): StartedAgentRecoveryCompactAttempt<Event> {
  const started = startAgentRecoveryAttemptWithStartedEffects(input);
  return {
    ...started,
    compactStream: buildAgentRecoveryCompactStreamFromHookContainer({
      conversation: input.conversation,
      hooks: input.hooks,
    }),
  };
}

export async function* startAgentRecoveryAttemptWithEmittedCompactStream<
  TMessage,
  Event,
>(
  input: StartAgentRecoveryAttemptWithEmittedCompactStreamInput<TMessage, Event>,
): AsyncGenerator<AgentRecoveryEvent, StartedAgentRecoveryCompactAttempt<Event>> {
  const started = startAgentRecoveryAttemptWithCompactStream(input);
  const effects = yield* emitAgentRecoveryEffects({
    effects: started.effects,
    hooks: input.hooks,
  });

  return {
    ...started,
    effects,
  };
}

export async function* runAgentRecoveryCompactAttemptWithEmissions<TMessage, Event>(
  input: StartAgentRecoveryAttemptWithEmittedCompactStreamInput<TMessage, Event>,
): AsyncGenerator<
  AgentRecoveryEvent | Event,
  AgentRecoveryCompactAttemptEmissionsResult
> {
  const started = yield* startAgentRecoveryAttemptWithEmittedCompactStream(input);
  if (!started.compactStream) {
    return {
      attempt: started.attempt,
      recovered: false,
      startedEffects: started.effects,
    };
  }

  const compactResultEffects = yield* consumeAgentRecoveryCompactStreamWithEmittedResultEffects({
    stream: started.compactStream,
    turn: input.turn,
    attempt: started.attempt,
    hooks: input.hooks,
  });

  return {
    attempt: started.attempt,
    recovered: compactResultEffects.recovered,
    startedEffects: started.effects,
    compactResultEffects,
  };
}

export async function* handleAgentReactiveCompactRecoveryWithEmissions<
  TMessage,
  Event,
>(
  input: HandleAgentReactiveCompactRecoveryWithEmissionsInput<TMessage, Event>,
): AsyncGenerator<
  AgentRecoveryEvent | Event | AgentLoopTurnRetryEvent,
  AgentReactiveCompactRecoveryHandling
> {
  if (
    !shouldAttemptAgentRecoveryFromHookContainer({
      error: input.error,
      hooks: input.hooks,
      tracker: input.tracker,
      turn: input.turn,
    })
  ) {
    return { action: 'unhandled' };
  }

  const compactRecovery = yield* runAgentRecoveryCompactAttemptWithEmissions({
    tracker: input.tracker,
    turn: input.turn,
    conversation: input.conversation,
    hooks: input.hooks,
  });

  if (!compactRecovery.recovered) {
    return { action: 'failed' };
  }

  input.epoch?.invalidate();
  const retryContinuation = applyAgentLoopReactiveCompactRetry({
    counter: input.counter,
    turn: input.turn,
  });
  for (const event of retryContinuation.events) {
    yield event;
  }

  return { action: 'retry' };
}

export async function* handleAgentRunTurnErrorWithEmissions<TMessage, Event>(
  input: HandleAgentRunTurnErrorWithEmissionsInput<TMessage, Event>,
): AsyncGenerator<
  AgentModelFallbackEvent | AgentRecoveryEvent | Event | AgentLoopTurnRetryEvent,
  AgentRunTurnErrorHandling
> {
  yield* handleAgentModelFallbackWithEmissions({
    error: input.error,
    epoch: input.epoch,
  });

  const reactiveCompactRecovery = yield* handleAgentReactiveCompactRecoveryWithEmissions(input);
  if (reactiveCompactRecovery.action === 'retry') {
    return { action: 'retry' };
  }
  if (reactiveCompactRecovery.action === 'failed') {
    throw input.error;
  }

  yield* emitAgentRecoveryExhaustedEffectsIfAttempted({
    error: input.error,
    turn: input.turn,
    tracker: input.tracker,
    hooks: input.hooks,
  });
  throw input.error;
}

export async function* handleAgentRunTurnSuccessWithEmissions<TResponse>(
  input: HandleAgentRunTurnSuccessWithEmissionsInput<TResponse>,
): AsyncGenerator<AgentRecoveryEvent, TResponse> {
  const response = assertAgentLoopTurnResponse(input.response);

  yield* emitAgentRecoveryResetEffects({
    tracker: input.tracker,
    turn: input.turn,
    hooks: input.hooks,
  });

  return response;
}

export function buildAgentRecoveryExhaustedProjectionInputFromTracker(
  input: AgentRecoveryExhaustedProjectionInputFromTrackerInput,
): AgentRecoveryExhaustedEffectsInput {
  return {
    kind: 'exhausted',
    turn: input.turn,
    attempt: input.tracker.attempt,
  };
}

export function buildAgentRecoveryExhaustedEffectsFromTracker(
  input: AgentRecoveryExhaustedProjectionInputFromTrackerInput,
): AgentRecoveryEffects {
  return buildAgentRecoveryExhaustedEffects(
    buildAgentRecoveryExhaustedProjectionInputFromTracker(input),
  );
}

export async function* emitAgentRecoveryExhaustedEffectsFromTracker(
  input: EmitAgentRecoveryExhaustedEffectsFromTrackerInput,
): AsyncGenerator<AgentRecoveryEvent, AgentRecoveryEffects> {
  return yield* emitAgentRecoveryEffects({
    effects: buildAgentRecoveryExhaustedEffectsFromTracker(input),
    hooks: input.hooks,
  });
}

export async function* emitAgentRecoveryExhaustedEffectsIfAttempted(
  input: EmitAgentRecoveryExhaustedEffectsIfAttemptedInput,
): AsyncGenerator<AgentRecoveryEvent, AgentRecoveryEffects | null> {
  if (
    !hasAgentRecoveryAttemptExhausted({
      error: input.error,
      tracker: input.tracker,
      turn: input.turn,
    })
  ) {
    return null;
  }

  return yield* emitAgentRecoveryExhaustedEffectsFromTracker(input);
}

export function shouldAttemptAgentRecovery({
  error,
  hasReactiveCompact,
  tracker,
  turn,
}: {
  error: unknown;
  hasReactiveCompact: boolean;
  tracker: Pick<AgentRecoveryAttemptTracker, 'canAttempt'>;
  turn: number;
}): boolean {
  return isOverflowRecoverable(error) && hasReactiveCompact && tracker.canAttempt(turn);
}

export function shouldAttemptAgentRecoveryFromHookContainer<TMessage, Event>({
  error,
  hooks,
  tracker,
  turn,
}: ShouldAttemptAgentRecoveryFromHookContainerInput<TMessage, Event>): boolean {
  return shouldAttemptAgentRecovery({
    error,
    hasReactiveCompact: hasAgentReactiveCompactHook({ hooks }),
    tracker,
    turn,
  });
}

export function hasAgentRecoveryAttemptExhausted({
  error,
  tracker,
  turn,
}: {
  error: unknown;
  tracker: Pick<AgentRecoveryAttemptTracker, 'hasAttemptedTurn'>;
  turn: number;
}): boolean {
  return isOverflowRecoverable(error) && tracker.hasAttemptedTurn(turn);
}
