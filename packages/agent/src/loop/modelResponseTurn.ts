import type { ChatResponse, Message } from '@blade-ai/ai/chat';
import {
  handleAgentLoopAssistantMessage,
  type AgentLoopAssistantMessageHookContainer,
} from './assistantMessage.js';
import {
  handleAgentLoopResponseNoToolGateWithEmissions,
  type AgentLoopNoToolCompleteHookContainer,
  type AgentLoopNoToolStopHookContainer,
  type AgentLoopResponseNoToolGateEvent,
  type AgentLoopResponseNoToolGateHandling,
} from './decideNoToolTurn.js';
import type {
  AgentLoopAbortCompletionTurnCounterLike,
  AgentLoopAbortResult,
  AgentLoopBudgetExhaustedResult,
} from './loopResult.js';
import {
  handleAgentLoopPostUsageGateWithEmissions,
  type AgentLoopPostUsageGateEvent,
  type AgentLoopTokenBudgetLike,
  type AgentLoopTokenBudgetTimingSource,
  type AgentLoopTokenBudgetToolResultTrackerLike,
  type AgentLoopTokenUsageEventTokenUsageTrackerLike,
} from './tokenUsage.js';
import type {
  AgentLoopTurnStateFields,
  AgentLoopTurnStateProjection,
} from './turnState.js';

export interface HandleAgentLoopModelResponseInput<
  TTurnState extends AgentLoopTurnStateFields,
  TSnapshot = unknown,
  StreamingExecutionResult = unknown,
> {
  tokenBudget?: AgentLoopTokenBudgetLike<TSnapshot>;
  response: Pick<ChatResponse, 'content' | 'reasoningContent' | 'toolCalls' | 'usage'>;
  streamingExecutionResults: readonly StreamingExecutionResult[] | undefined;
  conversation: {
    toArray(): readonly Message[];
    append(...messages: Message[]): void;
  };
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
  loopClock: AgentLoopTokenBudgetTimingSource;
  turnsCount: number;
  toolResultTracker: AgentLoopTokenBudgetToolResultTrackerLike;
  tokenUsageTracker: AgentLoopTokenUsageEventTokenUsageTrackerLike;
  signal?: AbortSignal;
  turnCounter: AgentLoopAbortCompletionTurnCounterLike;
  hooks?: AgentLoopAssistantMessageHookContainer
    & AgentLoopNoToolStopHookContainer
    & AgentLoopNoToolCompleteHookContainer;
}

export type AgentLoopModelResponseEvent<TSnapshot = unknown> =
  | AgentLoopPostUsageGateEvent<TSnapshot>
  | AgentLoopResponseNoToolGateEvent;

export type AgentLoopModelResponseHandling =
  | {
      action: 'continue_tool';
    }
  | Extract<AgentLoopResponseNoToolGateHandling, { action: 'continue_loop' | 'finish' }>
  | {
      action: 'stop';
      result: AgentLoopBudgetExhaustedResult;
    }
  | {
      action: 'abort';
      result: AgentLoopAbortResult;
    };

export async function* handleAgentLoopModelResponseWithEmissions<
  TTurnState extends AgentLoopTurnStateFields,
  TSnapshot = unknown,
  StreamingExecutionResult = unknown,
>(
  input: HandleAgentLoopModelResponseInput<TTurnState, TSnapshot, StreamingExecutionResult>,
): AsyncGenerator<AgentLoopModelResponseEvent<TSnapshot>, AgentLoopModelResponseHandling> {
  const postUsageGate = yield* handleAgentLoopPostUsageGateWithEmissions({
    tokenBudget: input.tokenBudget,
    modelUsage: input.response.usage,
    tokenUsageTracker: input.tokenUsageTracker,
    turnStateProjection: input.turnStateProjection,
    loopClock: input.loopClock,
    turnsCount: input.turnsCount,
    toolResultTracker: input.toolResultTracker,
    signal: input.signal,
    turnCounter: input.turnCounter,
  });
  if (postUsageGate.action === 'stop' || postUsageGate.action === 'abort') {
    return postUsageGate;
  }

  const responseNoToolGate = yield* handleAgentLoopResponseNoToolGateWithEmissions({
    response: input.response,
    signal: input.signal,
    streamingExecutionResults: input.streamingExecutionResults,
    conversation: input.conversation,
    turn: input.turnsCount,
    hooks: input.hooks,
    loopClock: input.loopClock,
    toolResultTracker: input.toolResultTracker,
    tokenUsageTracker: input.tokenUsageTracker,
    tokenBudget: input.tokenBudget,
  });
  if (responseNoToolGate.action === 'continue_loop' || responseNoToolGate.action === 'finish') {
    return responseNoToolGate;
  }

  await handleAgentLoopAssistantMessage({
    conversation: input.conversation,
    response: input.response,
    turn: input.turnsCount,
    hooks: input.hooks,
  });

  return { action: 'continue_tool' };
}
