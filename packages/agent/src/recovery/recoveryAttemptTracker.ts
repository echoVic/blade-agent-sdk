import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import {
  buildAgentRecoveryProjectionInput,
  type AgentRecoveryProjectionInput,
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

export function buildAgentRecoveryExhaustedProjectionInputFromTracker(
  input: AgentRecoveryExhaustedProjectionInputFromTrackerInput,
): AgentRecoveryProjectionInput {
  return buildAgentRecoveryProjectionInput({
    kind: 'exhausted',
    turn: input.turn,
    attempt: input.tracker.attempt,
  });
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
