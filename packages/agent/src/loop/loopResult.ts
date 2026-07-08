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
