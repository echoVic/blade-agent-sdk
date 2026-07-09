import type { ChatResponse, Message } from '@blade-ai/ai/chat';
import type { AgentLoopToolResultEpochLike } from '../epoch/ExecutionEpoch.js';
import type { AgentReactiveCompactRecoveryEpochLike } from '../recovery/recoveryAttemptTracker.js';
import {
  handleAgentLoopModelResponseWithEmissions,
  type AgentLoopModelResponseEvent,
  type AgentLoopModelResponseHandling,
  type HandleAgentLoopModelResponseInput,
} from './modelResponseTurn.js';
import type {
  ToolExecutionPermissionMode,
  ToolExecutionRegistryLike,
} from './planToolExecution.js';
import {
  handleAgentLoopRunTurnWithRecovery,
  type AgentLoopRunTurnPort,
  type AgentLoopRunTurnWithRecoveryEvent,
  type HandleAgentLoopRunTurnWithRecoveryInput,
} from './runTurnWithRecovery.js';
import type { AgentLoopToolInjectedMessagesInput } from './toolInjectedMessages.js';
import type { AgentLoopToolMessageInput } from './toolMessage.js';
import type { AgentLoopToolExecutionResultLike } from './toolResultContinuation.js';
import {
  handleAgentLoopToolResponseWithEmissions,
  type AgentLoopToolResponseEvent,
  type AgentLoopToolResponseHandling,
  type HandleAgentLoopToolResponseInput,
} from './toolResponseTurn.js';
import type { AgentLoopToolExitDecisionResultLike } from './loopResult.js';
import {
  handleAgentLoopTurnEntryWithEmissions,
  type AgentLoopTurnEntryEvent,
  type HandleAgentLoopTurnEntryInput,
} from './turnEntry.js';
import type {
  AgentLoopTurnStateFields,
} from './turnState.js';

export interface HandleAgentLoopTurnCycleInput<
  TMessage extends Message,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TEpoch extends AgentLoopTurnCycleEpochLike | null | undefined,
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
> {
  signal?: AbortSignal;
  loopClock: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['loopClock']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['loopClock']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['loopClock'];
  turnCounter: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['turnCounter']
    & HandleAgentLoopRunTurnWithRecoveryInput<
      TTurnState,
      TMessage,
      TExecutionPipeline,
      TEpoch,
      TLogger,
      TBeforeExec,
      TAfterExec,
      TAfterExecEpochDiscard,
      TOnUpdate,
      TEvent,
      TResponse,
      TStreamingExecutionResult
    >['counter']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['turnCounter']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['turnCounter'];
  effectiveMaxTurns: number;
  maxTurns: number;
  isYoloMode: boolean;
  toolResultTracker: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['toolResultTracker']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['toolResultTracker']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['toolResultTracker'];
  conversation: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['conversation']
    & HandleAgentLoopRunTurnWithRecoveryInput<
      TTurnState,
      TMessage,
      TExecutionPipeline,
      TEpoch,
      TLogger,
      TBeforeExec,
      TAfterExec,
      TAfterExecEpochDiscard,
      TOnUpdate,
      TEvent,
      TResponse,
      TStreamingExecutionResult
    >['conversation']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['conversation']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['conversation'];
  tokenUsageTracker: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['tokenUsageTracker']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['tokenUsageTracker']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['tokenUsageTracker'];
  prepareTurnState: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['prepareTurnState'];
  executionPipeline: TExecutionPipeline;
  streaming?: boolean;
  epoch: TEpoch;
  logger: TLogger;
  hooks?: HandleAgentLoopTurnEntryInput<
    TMessage,
    TEvent,
    TBeforeTurnReturn,
    TTurnState
  >['hooks']
    & HandleAgentLoopRunTurnWithRecoveryInput<
      TTurnState,
      TMessage,
      TExecutionPipeline,
      TEpoch,
      TLogger,
      TBeforeExec,
      TAfterExec,
      TAfterExecEpochDiscard,
      TOnUpdate,
      TEvent,
      TResponse,
      TStreamingExecutionResult
    >['hooks']
    & HandleAgentLoopModelResponseInput<
      TTurnState,
      TSnapshot,
      TStreamingExecutionResult
    >['hooks']
    & HandleAgentLoopToolResponseInput<
      TTurnState,
      TExecutionPipeline,
      TResult,
      TStreamingExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >['hooks'];
  tracker: HandleAgentLoopRunTurnWithRecoveryInput<
    TTurnState,
    TMessage,
    TExecutionPipeline,
    TEpoch,
    TLogger,
    TBeforeExec,
    TAfterExec,
    TAfterExecEpochDiscard,
    TOnUpdate,
    TEvent,
    TResponse,
    TStreamingExecutionResult
  >['tracker'];
  tokenBudget?: HandleAgentLoopModelResponseInput<
    TTurnState,
    TSnapshot,
    TStreamingExecutionResult
  >['tokenBudget'];
  runTurn: AgentLoopRunTurnPort<
    Parameters<
      HandleAgentLoopRunTurnWithRecoveryInput<
        TTurnState,
        TMessage,
        TExecutionPipeline,
        TEpoch,
        TLogger,
        TBeforeExec,
        TAfterExec,
        TAfterExecEpochDiscard,
        TOnUpdate,
        TEvent,
        TResponse,
        TStreamingExecutionResult
      >['runTurn']
    >[0],
    TEvent,
    TResponse,
    TStreamingExecutionResult
  >;
  executeToolCalls: HandleAgentLoopToolResponseInput<
    TTurnState,
    TExecutionPipeline,
    TResult,
    TStreamingExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >['executeToolCalls'];
}

export type AgentLoopTurnCycleEvent<
  TEvent,
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TSnapshot = unknown,
> =
  | AgentLoopTurnEntryEvent<TEvent>
  | AgentLoopRunTurnWithRecoveryEvent<TEvent>
  | AgentLoopModelResponseEvent<TSnapshot>
  | AgentLoopToolResponseEvent<TResult>;

export type AgentLoopTurnCycleHandling<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | {
      action: 'continue';
    }
  | Extract<AgentLoopModelResponseHandling, { action: 'abort' | 'stop' | 'finish' }>
  | Extract<AgentLoopToolResponseHandling<TResult>, { action: 'abort' | 'stop' }>
  | {
      action: 'exit';
      result: Extract<
        AgentLoopToolResponseHandling<TResult>,
        { action: 'exit' }
      >['exitDecision']['result'];
    };

export interface AgentLoopTurnCycleEpochLike
  extends AgentReactiveCompactRecoveryEpochLike,
    AgentLoopToolResultEpochLike {}

export async function* handleAgentLoopTurnCycleWithEmissions<
  TMessage extends Message,
  TEvent,
  TBeforeTurnReturn,
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TEpoch extends AgentLoopTurnCycleEpochLike | null | undefined,
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
  input: HandleAgentLoopTurnCycleInput<
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
  AgentLoopTurnCycleEvent<TEvent, TResult, TSnapshot>,
  AgentLoopTurnCycleHandling<TResult>
> {
  const turnEntry = yield* handleAgentLoopTurnEntryWithEmissions({
    signal: input.signal,
    loopClock: input.loopClock,
    turnCounter: input.turnCounter,
    effectiveMaxTurns: input.effectiveMaxTurns,
    toolResultTracker: input.toolResultTracker,
    conversation: input.conversation,
    tokenUsageTracker: input.tokenUsageTracker,
    hooks: input.hooks,
    prepareTurnState: input.prepareTurnState,
  });
  if (turnEntry.action === 'abort') {
    return turnEntry;
  }
  const { turnsCount, turnStateProjection } = turnEntry;

  const runTurnHandling = yield* handleAgentLoopRunTurnWithRecovery({
    turnStateProjection,
    conversation: input.conversation,
    executionPipeline: input.executionPipeline,
    streaming: input.streaming,
    signal: input.signal,
    epoch: input.epoch,
    logger: input.logger,
    hooks: input.hooks,
    tracker: input.tracker,
    turn: turnsCount,
    counter: input.turnCounter,
    runTurn: input.runTurn,
  });
  if (runTurnHandling.action === 'retry') {
    return { action: 'continue' };
  }

  const modelResponseHandling = yield* handleAgentLoopModelResponseWithEmissions({
    tokenBudget: input.tokenBudget,
    response: runTurnHandling.turnResult,
    streamingExecutionResults: runTurnHandling.streamingExecutionResults,
    conversation: input.conversation,
    turnStateProjection,
    loopClock: input.loopClock,
    turnsCount,
    toolResultTracker: input.toolResultTracker,
    tokenUsageTracker: input.tokenUsageTracker,
    signal: input.signal,
    turnCounter: input.turnCounter,
    hooks: input.hooks,
  });
  if (modelResponseHandling.action === 'continue_loop') {
    return { action: 'continue' };
  }
  if (modelResponseHandling.action !== 'continue_tool') {
    return modelResponseHandling;
  }

  const toolResponseHandling = yield* handleAgentLoopToolResponseWithEmissions({
    executionResults: runTurnHandling.streamingExecutionResults,
    response: runTurnHandling.turnResult,
    executionPipeline: input.executionPipeline,
    turnStateProjection,
    logger: input.logger,
    signal: input.signal,
    loopClock: input.loopClock,
    turnsCount,
    toolResultTracker: input.toolResultTracker,
    executeToolCalls: input.executeToolCalls,
    conversation: input.conversation,
    epoch: input.epoch,
    streamingExecutionResults: runTurnHandling.streamingExecutionResults,
    hooks: input.hooks,
    maxTurns: input.maxTurns,
    effectiveMaxTurns: input.effectiveMaxTurns,
    isYoloMode: input.isYoloMode,
    tokenUsageTracker: input.tokenUsageTracker,
    turnCounter: input.turnCounter,
  });
  if (toolResponseHandling.action === 'exit') {
    return {
      action: 'exit',
      result: toolResponseHandling.exitDecision.result,
    };
  }
  if (toolResponseHandling.action === 'abort' || toolResponseHandling.action === 'stop') {
    return toolResponseHandling;
  }

  return { action: 'continue' };
}
