import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import {
  buildAgentRecoveryExhaustedEffects,
  buildAgentRecoveryResetEffects,
  buildAgentRecoveryStartedEffects,
  type AgentRecoveryEffects,
  type AgentRecoveryExhaustedEffectsInput,
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

export interface StartAgentRecoveryAttemptInput {
  tracker: Pick<AgentRecoveryAttemptTracker, 'startAttempt'>;
  turn: number;
}

export interface StartedAgentRecoveryAttempt {
  attempt: number;
  effects: AgentRecoveryEffects;
}

export interface ConsumeAgentRecoveryResetEffectsInput {
  tracker: Pick<AgentRecoveryAttemptTracker, 'consumeResetAttempt'>;
  turn: number;
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
