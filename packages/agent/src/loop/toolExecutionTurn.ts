import type { Message } from '@blade-ai/ai/chat';
import {
  handleAgentLoopNonStreamingToolExecutionWithEmissions,
  type AgentLoopNonStreamingToolExecutionGateEvent,
  type HandleAgentLoopNonStreamingToolExecutionInput,
  type ToolExecutionPermissionMode,
  type ToolExecutionRegistryLike,
} from './planToolExecution.js';
import type { AgentLoopTurnStateFields } from './turnState.js';
import {
  handleAgentLoopToolResults,
  type AgentLoopToolExecutionResultLike,
  type AgentLoopToolResultAfterExecHookContainer,
  type AgentLoopToolResultContinuationConversationLike,
  type AgentLoopToolResultsHandling,
  type AgentLoopToolResultHandlingEvent,
} from './toolResultContinuation.js';
import type { AgentLoopToolResultEpochLike } from '../epoch/ExecutionEpoch.js';
import type {
  AgentLoopAbortResult,
  AgentLoopToolExitDecisionResultLike,
  AgentLoopToolExitTimingSource,
  AgentLoopToolExitToolResultTrackerLike,
} from './loopResult.js';
import type { AgentToolResultTracker } from './toolResultTracker.js';
import type { AgentLoopToolMessageInput } from './toolMessage.js';
import type { AgentLoopToolInjectedMessagesInput } from './toolInjectedMessages.js';

export interface HandleAgentLoopToolExecutionResultsInput<
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
> extends HandleAgentLoopNonStreamingToolExecutionInput<
    TTurnState,
    TExecutionPipeline,
    AgentLoopToolExecutionResultLike<TResult>,
    TLogger,
    TBeforeExec,
    TOnUpdate
  > {
  epoch: AgentLoopToolResultEpochLike | null | undefined;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
  loopClock: AgentLoopToolExitTimingSource;
  toolResultTracker: AgentToolResultTracker<TResult> & AgentLoopToolExitToolResultTrackerLike;
  conversation: AgentLoopToolResultContinuationConversationLike;
  hooks?: AgentLoopToolResultAfterExecHookContainer<TResult>
    & HandleAgentLoopNonStreamingToolExecutionInput<
      TTurnState,
      TExecutionPipeline,
      AgentLoopToolExecutionResultLike<TResult>,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['hooks'];
}

export type AgentLoopToolExecutionResultsEvent<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | AgentLoopNonStreamingToolExecutionGateEvent
  | AgentLoopToolResultHandlingEvent<TResult>;

export type AgentLoopToolExecutionResultsHandling<
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
  | AgentLoopToolResultsHandling<TResult>;

export async function* handleAgentLoopToolExecutionResultsWithEmissions<
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
  input: HandleAgentLoopToolExecutionResultsInput<
    TTurnState,
    TExecutionPipeline,
    TResult,
    TStreamingExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
): AsyncGenerator<
  AgentLoopToolExecutionResultsEvent<TResult>,
  AgentLoopToolExecutionResultsHandling<TResult>
> {
  const execution = yield* handleAgentLoopNonStreamingToolExecutionWithEmissions(input);
  if (execution.action === 'abort') {
    return execution;
  }

  const toolResultsHandling = yield* handleAgentLoopToolResults({
    executionResults: execution.executionResults,
    epoch: input.epoch,
    streamingExecutionResults: input.streamingExecutionResults,
    loopClock: input.loopClock,
    turnsCount: input.turnsCount,
    toolResultTracker: input.toolResultTracker,
    conversation: input.conversation,
    hooks: input.hooks,
  });
  if (toolResultsHandling.action === 'exit') {
    return toolResultsHandling;
  }

  return { action: 'continue' };
}
