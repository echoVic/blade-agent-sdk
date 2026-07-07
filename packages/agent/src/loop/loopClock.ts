import type { AgentLoopResultTiming } from './loopResult.js';

export interface AgentLoopClockOptions {
  now?: () => number;
}

export interface AgentLoopClockTimingInput {
  turnsCount: number;
  toolCallsCount: number;
}

export interface AgentLoopClock {
  readonly startTime: number;
  resultTiming(input: AgentLoopClockTimingInput): AgentLoopResultTiming;
}

export function createAgentLoopClock(options: AgentLoopClockOptions = {}): AgentLoopClock {
  const now = options.now ?? Date.now;
  const startTime = now();

  return {
    get startTime() {
      return startTime;
    },
    resultTiming(input: AgentLoopClockTimingInput): AgentLoopResultTiming {
      return {
        turnsCount: input.turnsCount,
        toolCallsCount: input.toolCallsCount,
        startTime,
        now: now(),
      };
    },
  };
}
