import type { Message } from '@blade-ai/ai/chat';
import type { AgentLoopToolResultEpochLike } from '../epoch/ExecutionEpoch.js';
import {
  handleAgentLoopToolTurnTail,
  type AgentLoopToolTurnTailClockLike,
  type AgentLoopToolTurnTailEvent,
  type AgentLoopToolTurnTailHandling,
  type AgentLoopToolTurnTailTurnCounterLike,
  type AgentLoopTurnLimitContinuationConversationLike,
  type AgentLoopTurnLimitConversationLike,
  type AgentLoopTurnLimitHookContainer,
  type AgentLoopTurnLimitTokenUsageTrackerLike,
  type AgentLoopTurnLimitToolResultTrackerLike,
} from './decideTurnLimit.js';
import type {
  AgentLoopAbortResult,
  AgentLoopToolExitDecisionResultLike,
  AgentLoopToolExitTimingSource,
  AgentLoopToolExitToolResultTrackerLike,
} from './loopResult.js';
import type {
  HandleAgentLoopNonStreamingToolExecutionInput,
  ToolExecutionPermissionMode,
  ToolExecutionRegistryLike,
} from './planToolExecution.js';
import type { AgentLoopToolInjectedMessagesInput } from './toolInjectedMessages.js';
import {
  handleAgentLoopToolExecutionResultsWithEmissions,
  type AgentLoopToolExecutionResultsEvent,
  type HandleAgentLoopToolExecutionResultsInput,
} from './toolExecutionTurn.js';
import type { AgentLoopToolMessageInput } from './toolMessage.js';
import type {
  AgentLoopToolExecutionResultLike,
  AgentLoopToolResultAfterExecHookContainer,
  AgentLoopToolResultContinuationConversationLike,
  AgentLoopToolResultsHandling,
} from './toolResultContinuation.js';
import type { AgentToolResultTracker } from './toolResultTracker.js';
import type { AgentLoopTurnStateFields } from './turnState.js';

export interface HandleAgentLoopToolResponseInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
> extends Omit<
    HandleAgentLoopToolExecutionResultsInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >,
    'conversation' | 'hooks' | 'loopClock' | 'toolResultTracker'
  > {
  loopClock: AgentLoopToolExitTimingSource & AgentLoopToolTurnTailClockLike;
  toolResultTracker: AgentToolResultTracker<TResult>
    & AgentLoopToolExitToolResultTrackerLike
    & AgentLoopTurnLimitToolResultTrackerLike;
  conversation: AgentLoopToolResultContinuationConversationLike
    & AgentLoopTurnLimitConversationLike
    & AgentLoopTurnLimitContinuationConversationLike;
  tokenUsageTracker: AgentLoopTurnLimitTokenUsageTrackerLike;
  turnCounter: AgentLoopToolTurnTailTurnCounterLike;
  maxTurns: number;
  effectiveMaxTurns: number;
  isYoloMode: boolean;
  hooks?: AgentLoopToolResultAfterExecHookContainer<TResult>
    & HandleAgentLoopNonStreamingToolExecutionInput<
      TTurnState,
      TExecutionPipeline,
      AgentLoopToolExecutionResultLike<TResult>,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['hooks']
    & AgentLoopTurnLimitHookContainer;
  epoch: AgentLoopToolResultEpochLike | null | undefined;
}

export type AgentLoopToolResponseEvent<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | AgentLoopToolExecutionResultsEvent<TResult>
  | AgentLoopToolTurnTailEvent;

export type AgentLoopToolResponseHandling<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | {
      action: 'continue';
    }
  | {
      action: 'abort';
      result: AgentLoopAbortResult;
    }
  | Extract<AgentLoopToolResultsHandling<TResult>, { action: 'exit' }>
  | Extract<AgentLoopToolTurnTailHandling, { action: 'stop' }>;

export async function* handleAgentLoopToolResponseWithEmissions<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: HandleAgentLoopToolResponseInput<
    TTurnState,
    TExecutionPipeline,
    TResult,
    TStreamingExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
): AsyncGenerator<
  AgentLoopToolResponseEvent<TResult>,
  AgentLoopToolResponseHandling<TResult>
> {
  const toolExecutionResults =
    yield* handleAgentLoopToolExecutionResultsWithEmissions(input);
  if (toolExecutionResults.action === 'abort' || toolExecutionResults.action === 'exit') {
    return toolExecutionResults;
  }

  const toolTurnTail = yield* handleAgentLoopToolTurnTail({
    signal: input.signal,
    loopClock: input.loopClock,
    turnsCount: input.turnsCount,
    maxTurns: input.maxTurns,
    effectiveMaxTurns: input.effectiveMaxTurns,
    isYoloMode: input.isYoloMode,
    conversation: input.conversation,
    toolResultTracker: input.toolResultTracker,
    tokenUsageTracker: input.tokenUsageTracker,
    turnCounter: input.turnCounter,
    hooks: input.hooks,
  });
  if (toolTurnTail.action === 'abort' || toolTurnTail.action === 'stop') {
    return toolTurnTail;
  }

  return { action: 'continue' };
}
