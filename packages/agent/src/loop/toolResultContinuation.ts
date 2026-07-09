import type { Message } from '@blade-ai/ai/chat';
import {
  shouldEmitAgentLoopNonStreamingToolResultEffects,
  type AgentFunctionToolCall,
} from './planToolExecution.js';
import {
  shouldStopAgentLoopToolResultProcessing,
  type AgentLoopToolResultEpochLike,
} from '../epoch/ExecutionEpoch.js';
import {
  buildAgentLoopToolInjectedMessages,
  type AgentLoopToolInjectedMessagesInput,
} from './toolInjectedMessages.js';
import {
  buildAgentLoopToolMessage,
  type AgentLoopToolMessageInput,
} from './toolMessage.js';
import {
  buildAgentLoopToolResultEvent,
} from './toolUpdateToAgentEvent.js';
import {
  buildAgentLoopToolExitDecision,
  buildAgentLoopToolExitDecisionInputFromLoopState,
  shouldExitAgentLoopForToolDecision,
  type AgentLoopToolExitDecisionEvent,
  type AgentLoopToolExitDecisionExit,
  type AgentLoopToolExitDecisionResultLike,
  type AgentLoopToolExitTimingSource,
  type AgentLoopToolExitToolResultTrackerLike,
} from './loopResult.js';
import {
  recordAgentToolResult,
  type AgentToolResultTracker,
} from './toolResultTracker.js';

export interface AgentLoopToolResultContinuationInput<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
  TStreamingExecutionResult,
> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
}

export interface AgentLoopToolResultContinuation<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
> {
  events: Array<{
    type: 'tool_result';
    toolCall: AgentFunctionToolCall;
    result: TResult;
  }>;
  shouldRunAfterExecHook: boolean;
  toolMessage: Message;
  injectedMessages: Message[];
}

export interface AgentLoopToolResultAppendMessagesInput {
  toolMessage: Message;
  injectedMessages: Message[];
}

export interface AgentLoopToolResultContinuationConversationLike {
  append(...messages: Message[]): void;
}

export interface ApplyAgentLoopToolResultContinuationInput<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
> {
  conversation: AgentLoopToolResultContinuationConversationLike;
  continuation: AgentLoopToolResultContinuation<TResult>;
}

export interface AgentLoopAfterExecHookPayloadInput<TResult> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  toolUseUuid: string | null;
}

export interface AgentLoopAfterExecHookPayload<TResult> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  toolUseUuid: string | null;
}

export interface AgentLoopToolResultAfterExecHookContainer<TResult> {
  tool?: {
    afterExec?: (payload: AgentLoopAfterExecHookPayload<TResult>) => Promise<void> | void;
  } | null;
}

export interface RunAgentLoopToolResultAfterExecHookInput<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
> {
  continuation: AgentLoopToolResultContinuation<TResult>;
  hooks?: AgentLoopToolResultAfterExecHookContainer<TResult> | null;
  toolCall: AgentFunctionToolCall;
  result: TResult;
  toolUseUuid: string | null;
}

export interface HandleAgentLoopToolResultInput<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  toolUseUuid: string | null;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
  loopClock: AgentLoopToolExitTimingSource;
  turnsCount: number;
  toolResultTracker: AgentToolResultTracker<TResult> & AgentLoopToolExitToolResultTrackerLike;
  conversation: AgentLoopToolResultContinuationConversationLike;
  hooks?: AgentLoopToolResultAfterExecHookContainer<TResult> | null;
}

export interface AgentLoopToolExecutionResultLike<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> {
  toolCall: AgentFunctionToolCall;
  result: TResult;
  toolUseUuid: string | null;
}

export interface HandleAgentLoopToolResultsInput<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
> {
  executionResults: readonly AgentLoopToolExecutionResultLike<TResult>[];
  epoch: AgentLoopToolResultEpochLike | null | undefined;
  streamingExecutionResults: readonly TStreamingExecutionResult[] | undefined;
  loopClock: AgentLoopToolExitTimingSource;
  turnsCount: number;
  toolResultTracker: AgentToolResultTracker<TResult> & AgentLoopToolExitToolResultTrackerLike;
  conversation: AgentLoopToolResultContinuationConversationLike;
  hooks?: AgentLoopToolResultAfterExecHookContainer<TResult> | null;
}

export type AgentLoopToolResultHandling<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
> =
  | {
      action: 'continue';
      continuation: AgentLoopToolResultContinuation<TResult>;
    }
  | {
      action: 'exit';
      exitDecision: AgentLoopToolExitDecisionExit<TResult>;
    };

export type AgentLoopToolResultHandlingEvent<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
> =
  | AgentLoopToolResultContinuation<TResult>['events'][number]
  | AgentLoopToolExitDecisionEvent<TResult>;

export type AgentLoopToolResultsHandling<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
> =
  | {
      action: 'continue';
    }
  | {
      action: 'exit';
      exitDecision: AgentLoopToolExitDecisionExit<TResult>;
    };

export function buildAgentLoopToolResultContinuation<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
  TStreamingExecutionResult,
>(
  input: AgentLoopToolResultContinuationInput<TResult, TStreamingExecutionResult>,
): AgentLoopToolResultContinuation<TResult> {
  const shouldRunAfterExecHook = shouldEmitAgentLoopNonStreamingToolResultEffects(
    input.streamingExecutionResults,
  );

  return {
    events: shouldRunAfterExecHook
      ? [buildAgentLoopToolResultEvent({ toolCall: input.toolCall, result: input.result })]
      : [],
    shouldRunAfterExecHook,
    toolMessage: buildAgentLoopToolMessage({
      toolCall: input.toolCall,
      result: input.result,
    }),
    injectedMessages: buildAgentLoopToolInjectedMessages({
      newMessages: input.result.newMessages,
    }),
  };
}

export function buildAgentLoopAfterExecHookPayload<TResult>(
  input: AgentLoopAfterExecHookPayloadInput<TResult>,
): AgentLoopAfterExecHookPayload<TResult> {
  return {
    toolCall: input.toolCall,
    result: input.result,
    toolUseUuid: input.toolUseUuid,
  };
}

export function buildAgentLoopToolResultAppendMessages(
  input: AgentLoopToolResultAppendMessagesInput,
): Message[] {
  return [input.toolMessage, ...input.injectedMessages];
}

export function applyAgentLoopToolResultContinuation<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
>(
  input: ApplyAgentLoopToolResultContinuationInput<TResult>,
): AgentLoopToolResultContinuation<TResult> {
  input.conversation.append(...buildAgentLoopToolResultAppendMessages(input.continuation));
  return input.continuation;
}

export async function runAgentLoopToolResultAfterExecHook<
  TResult extends AgentLoopToolMessageInput['result'] & AgentLoopToolInjectedMessagesInput<Message>,
>(
  input: RunAgentLoopToolResultAfterExecHookInput<TResult>,
): Promise<AgentLoopToolResultContinuation<TResult>> {
  if (input.continuation.shouldRunAfterExecHook) {
    await input.hooks?.tool?.afterExec?.(
      buildAgentLoopAfterExecHookPayload({
        toolCall: input.toolCall,
        result: input.result,
        toolUseUuid: input.toolUseUuid,
      }),
    );
  }

  return input.continuation;
}

export async function* handleAgentLoopToolResult<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
>(
  input: HandleAgentLoopToolResultInput<TResult, TStreamingExecutionResult>,
): AsyncGenerator<
  AgentLoopToolResultHandlingEvent<TResult>,
  AgentLoopToolResultHandling<TResult>
> {
  recordAgentToolResult({ tracker: input.toolResultTracker, result: input.result });

  const exitDecision = buildAgentLoopToolExitDecision(
    buildAgentLoopToolExitDecisionInputFromLoopState({
      toolCall: input.toolCall,
      result: input.result,
      streamingExecutionResults: input.streamingExecutionResults,
      loopClock: input.loopClock,
      turnsCount: input.turnsCount,
      toolResultTracker: input.toolResultTracker,
    }),
  );

  if (shouldExitAgentLoopForToolDecision(exitDecision)) {
    for (const event of exitDecision.events) {
      yield event;
    }
    return {
      action: 'exit',
      exitDecision,
    };
  }

  const continuation = buildAgentLoopToolResultContinuation({
    toolCall: input.toolCall,
    result: input.result,
    streamingExecutionResults: input.streamingExecutionResults,
  });
  for (const event of continuation.events) {
    yield event;
  }

  await runAgentLoopToolResultAfterExecHook({
    continuation,
    hooks: input.hooks,
    toolCall: input.toolCall,
    result: input.result,
    toolUseUuid: input.toolUseUuid,
  });

  applyAgentLoopToolResultContinuation({
    conversation: input.conversation,
    continuation,
  });

  return {
    action: 'continue',
    continuation,
  };
}

export async function* handleAgentLoopToolResults<
  TResult extends AgentLoopToolMessageInput['result']
    & AgentLoopToolInjectedMessagesInput<Message>
    & AgentLoopToolExitDecisionResultLike,
  TStreamingExecutionResult,
>(
  input: HandleAgentLoopToolResultsInput<TResult, TStreamingExecutionResult>,
): AsyncGenerator<
  AgentLoopToolResultHandlingEvent<TResult>,
  AgentLoopToolResultsHandling<TResult>
> {
  for (const { toolCall, result, toolUseUuid } of input.executionResults) {
    if (shouldStopAgentLoopToolResultProcessing(input.epoch)) {
      break;
    }

    const toolResultHandling = yield* handleAgentLoopToolResult({
      toolCall,
      result,
      toolUseUuid,
      streamingExecutionResults: input.streamingExecutionResults,
      loopClock: input.loopClock,
      turnsCount: input.turnsCount,
      toolResultTracker: input.toolResultTracker,
      conversation: input.conversation,
      hooks: input.hooks,
    });
    if (toolResultHandling.action === 'exit') {
      return {
        action: 'exit',
        exitDecision: toolResultHandling.exitDecision,
      };
    }
  }

  return { action: 'continue' };
}
