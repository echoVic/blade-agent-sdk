import type { ChatResponse, Message } from '@blade-ai/ai/chat';
import { createAgentRecoveryAttemptTracker } from '../recovery/recoveryAttemptTracker.js';
import { buildAgentLoopEffectiveMaxTurns } from './decideTurnLimit.js';
import {
  buildAgentLoopStartEvent,
  type AgentLoopStartEvent,
} from './loopEvents.js';
import { createAgentLoopClock } from './loopClock.js';
import {
  handleAgentLoopTurnCycleWithEmissions,
  type AgentLoopTurnCycleEpochLike,
  type AgentLoopTurnCycleEvent,
  type AgentLoopTurnCycleHandling,
  type HandleAgentLoopTurnCycleInput,
} from './turnCycle.js';
import { createAgentLoopTokenUsageTracker } from './tokenUsageTracker.js';
import type { AgentLoopToolInjectedMessagesInput } from './toolInjectedMessages.js';
import type { AgentLoopToolMessageInput } from './toolMessage.js';
import { createAgentToolResultTracker } from './toolResultTracker.js';
import type { AgentLoopToolExecutionResultLike } from './toolResultContinuation.js';
import { createAgentLoopTurnCounter } from './turnCounter.js';
import type { AgentLoopToolExitDecisionResultLike } from './loopResult.js';
import type {
  ToolExecutionPermissionMode,
  ToolExecutionRegistryLike,
} from './planToolExecution.js';
import type { AgentLoopTurnStateFields } from './turnState.js';

export interface HandleAgentLoopInput<
  TMessage extends Message,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TEpoch extends AgentLoopTurnCycleEpochLike,
  TLogger,
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
  TResponse extends Pick<
    ChatResponse,
    'content' | 'reasoningContent' | 'toolCalls' | 'usage'
  >,
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult extends AgentLoopToolExecutionResultLike<TResult>,
  TSnapshot = unknown,
> extends Omit<
    HandleAgentLoopTurnCycleInput<
      TMessage,
      TEvent,
      TBeforeTurnReturn,
      TTurnState,
      TExecutionPipeline,
      TEpoch,
      TLogger,
      TBeforeExec,
      TAfterExec,
      TAfterExecEpochDiscard,
      TOnUpdate,
      TResponse,
      TResult,
      TStreamingExecutionResult,
      TSnapshot
    >,
    | 'loopClock'
    | 'turnCounter'
    | 'effectiveMaxTurns'
    | 'toolResultTracker'
    | 'tokenUsageTracker'
    | 'tracker'
    | 'epoch'
  > {
  createEpoch(): TEpoch;
}

export type AgentLoopEvent<
  TEvent,
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TSnapshot = unknown,
> =
  | AgentLoopStartEvent
  | AgentLoopTurnCycleEvent<TEvent, TResult, TSnapshot>;

export type AgentLoopResult<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | Extract<AgentLoopTurnCycleHandling<TResult>, { action: 'abort' | 'stop' | 'finish' }>['result']
  | Extract<AgentLoopTurnCycleHandling<TResult>, { action: 'exit' }>['result'];

export async function* handleAgentLoopWithEmissions<
  TMessage extends Message,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TEpoch extends AgentLoopTurnCycleEpochLike,
  TLogger,
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
  TResponse extends Pick<
    ChatResponse,
    'content' | 'reasoningContent' | 'toolCalls' | 'usage'
  >,
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult extends AgentLoopToolExecutionResultLike<TResult>,
  TSnapshot = unknown,
>(
  input: HandleAgentLoopInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState,
    TExecutionPipeline,
    TEpoch,
    TLogger,
    TBeforeExec,
    TAfterExec,
    TAfterExecEpochDiscard,
    TOnUpdate,
    TResponse,
    TResult,
    TStreamingExecutionResult,
    TSnapshot
  >,
): AsyncGenerator<
  AgentLoopEvent<TEvent, TResult, TSnapshot>,
  AgentLoopResult<TResult>
> {
  const effectiveMaxTurns = buildAgentLoopEffectiveMaxTurns({
    maxTurns: input.maxTurns,
    isYoloMode: input.isYoloMode,
  });
  const loopClock = createAgentLoopClock();
  const turnCounter = createAgentLoopTurnCounter();
  const toolResultTracker = createAgentToolResultTracker<TResult>();
  const recoveryAttemptTracker = createAgentRecoveryAttemptTracker();
  const tokenUsageTracker = createAgentLoopTokenUsageTracker();

  yield buildAgentLoopStartEvent();

  while (true) {
    const turnCycle = yield* handleAgentLoopTurnCycleWithEmissions({
      ...input,
      loopClock,
      turnCounter,
      effectiveMaxTurns,
      toolResultTracker,
      tokenUsageTracker,
      tracker: recoveryAttemptTracker,
      epoch: input.createEpoch(),
    });
    if (turnCycle.action === 'continue') {
      continue;
    }

    return turnCycle.result;
  }
}
