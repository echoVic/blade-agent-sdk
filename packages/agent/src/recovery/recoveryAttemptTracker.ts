export interface AgentRecoveryAttemptTracker {
  readonly attempt: number;
  canAttempt(turn: number): boolean;
  hasAttemptedTurn(turn: number): boolean;
  startAttempt(turn: number): number;
  consumeResetAttempt(): number | null;
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
