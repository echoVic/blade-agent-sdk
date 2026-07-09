import type { AgentLoopTurnStateFields } from './turnState.js';
import {
  buildAgentLoopRunTurnInputFromLoopState,
  consumeAgentLoopTurnStream,
  type AgentLoopRunTurnConversationLike,
  type AgentLoopRunTurnHookContainerInput,
  type AgentLoopRunTurnInput,
  type AgentLoopRunTurnLoopStateInput,
  type AgentLoopRunTurnToolHooks,
  type AgentLoopRunTurnToolHooksInput,
  type AgentLoopTurnStreamOutcome,
} from './turnStream.js';
import {
  handleAgentRunTurnErrorWithEmissions,
  handleAgentRunTurnSuccessWithEmissions,
  type AgentRecoveryAttemptTracker,
  type AgentReactiveCompactRecoveryEpochLike,
  type AgentRunTurnErrorHandling,
  type HandleAgentRunTurnErrorWithEmissionsInput,
  type HandleAgentRunTurnSuccessWithEmissionsInput,
} from '../recovery/recoveryAttemptTracker.js';
import type { AgentLoopTurnRetryEvent } from './loopEvents.js';
import type {
  AgentModelFallbackEvent,
  AgentRecoveryEvent,
  AgentReactiveCompactConversationLike,
} from '../recovery/recoveryEvents.js';

export type AgentLoopRunTurnPort<
  TRunTurnInput,
  TEvent,
  TResponse,
  TStreamingExecutionResult,
> = (
  input: TRunTurnInput,
) => AsyncGenerator<
  TEvent,
  AgentLoopTurnStreamOutcome<TResponse, TStreamingExecutionResult>
>;

export interface HandleAgentLoopRunTurnWithRecoveryInput<
  TTurnState extends AgentLoopTurnStateFields,
  TMessage,
  TExecutionPipeline,
  TEpoch extends AgentReactiveCompactRecoveryEpochLike | null | undefined,
  TLogger,
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
  TEvent,
  TResponse,
  TStreamingExecutionResult,
> extends Omit<
    AgentLoopRunTurnLoopStateInput<
      TTurnState,
      readonly TMessage[],
      TExecutionPipeline,
      TEpoch,
      TLogger,
      TBeforeExec,
      TAfterExec,
      TAfterExecEpochDiscard,
      TOnUpdate
    >,
    'conversation' | 'hooks' | 'toolHooks'
  >,
    Pick<HandleAgentRunTurnSuccessWithEmissionsInput<TResponse>, 'turn'> {
  conversation: AgentLoopRunTurnConversationLike<readonly TMessage[]>
    & AgentReactiveCompactConversationLike<TMessage>;
  tracker: Pick<
    AgentRecoveryAttemptTracker,
    | 'attempt'
    | 'canAttempt'
    | 'hasAttemptedTurn'
    | 'startAttempt'
    | 'consumeResetAttempt'
  >;
  hooks?: (AgentLoopRunTurnHookContainerInput<
    TBeforeExec,
    TAfterExec,
    TAfterExecEpochDiscard,
    TOnUpdate
  > & HandleAgentRunTurnErrorWithEmissionsInput<TMessage, TEvent>['hooks'])
    | null;
  toolHooks?: AgentLoopRunTurnToolHooksInput<
    TBeforeExec,
    TAfterExec,
    TAfterExecEpochDiscard,
    TOnUpdate
  > | null;
  counter: HandleAgentRunTurnErrorWithEmissionsInput<TMessage, TEvent>['counter'];
  runTurn: AgentLoopRunTurnPort<
    AgentLoopRunTurnInput<
      TTurnState,
      readonly TMessage[],
      TExecutionPipeline,
      TEpoch,
      TTurnState['executionContext'],
      TTurnState['permissionMode'],
      TLogger,
      AgentLoopRunTurnToolHooks<
        TBeforeExec,
        TAfterExec,
        TAfterExecEpochDiscard,
        TOnUpdate
      >
    >,
    TEvent,
    TResponse,
    TStreamingExecutionResult
  >;
}

export type AgentLoopRunTurnWithRecoveryHandling<TResponse, TStreamingExecutionResult> =
  | AgentRunTurnErrorHandling
  | {
      action: 'continue';
      turnResult: TResponse;
      streamingExecutionResults?: TStreamingExecutionResult[];
    };

export type AgentLoopRunTurnWithRecoveryEvent<TEvent> =
  | TEvent
  | AgentModelFallbackEvent
  | AgentRecoveryEvent
  | AgentLoopTurnRetryEvent;

export async function* handleAgentLoopRunTurnWithRecovery<
  TTurnState extends AgentLoopTurnStateFields,
  TMessage,
  TExecutionPipeline,
  TEpoch extends AgentReactiveCompactRecoveryEpochLike | null | undefined,
  TLogger,
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
  TEvent,
  TResponse,
  TStreamingExecutionResult,
>(
  input: HandleAgentLoopRunTurnWithRecoveryInput<
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
  >,
): AsyncGenerator<
  AgentLoopRunTurnWithRecoveryEvent<TEvent>,
  AgentLoopRunTurnWithRecoveryHandling<TResponse, TStreamingExecutionResult>
> {
  let response: TResponse | undefined;
  let streamingExecutionResults: TStreamingExecutionResult[] | undefined;

  try {
    const turnStreamResult = yield* consumeAgentLoopTurnStream(
      input.runTurn(buildAgentLoopRunTurnInputFromLoopState(input)),
    );
    response = turnStreamResult.turnResult;
    streamingExecutionResults = turnStreamResult.streamingExecutionResults;
  } catch (error) {
    const errorHandling = yield* handleAgentRunTurnErrorWithEmissions({
      error,
      tracker: input.tracker,
      turn: input.turn,
      conversation: input.conversation,
      hooks: input.hooks,
      epoch: input.epoch,
      counter: input.counter,
    });
    if (errorHandling.action === 'retry') {
      return errorHandling;
    }
  }

  return {
    action: 'continue',
    turnResult: yield* handleAgentRunTurnSuccessWithEmissions({
      response,
      tracker: input.tracker,
      turn: input.turn,
      hooks: input.hooks,
    }),
    streamingExecutionResults,
  };
}
