export interface AgentLoopTurnStart {
  started: boolean;
  turn: number;
}

export interface AgentLoopTurnCounter {
  readonly turnsCount: number;
  readonly previousCompletedTurnCount: number;
  shouldRunBeforeTurn(): boolean;
  beginTurn(): AgentLoopTurnStart;
  requestRetry(): void;
  reset(): void;
}

export function createAgentLoopTurnCounter(): AgentLoopTurnCounter {
  let turnsCount = 0;
  let retryCurrentTurn = false;

  return {
    get turnsCount() {
      return turnsCount;
    },
    get previousCompletedTurnCount() {
      return Math.max(0, turnsCount - 1);
    },
    shouldRunBeforeTurn(): boolean {
      return !retryCurrentTurn;
    },
    beginTurn(): AgentLoopTurnStart {
      if (retryCurrentTurn) {
        retryCurrentTurn = false;
        return { started: false, turn: turnsCount };
      }

      turnsCount += 1;
      return { started: true, turn: turnsCount };
    },
    requestRetry(): void {
      retryCurrentTurn = true;
    },
    reset(): void {
      turnsCount = 0;
      retryCurrentTurn = false;
    },
  };
}
