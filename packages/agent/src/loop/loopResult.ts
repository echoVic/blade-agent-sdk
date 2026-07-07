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

export interface AgentLoopResultTiming {
  turnsCount: number;
  toolCallsCount: number;
  startTime: number;
  now?: number;
}

function getLoopDuration(input: Pick<AgentLoopResultTiming, 'startTime' | 'now'>): number {
  return (input.now ?? Date.now()) - input.startTime;
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
