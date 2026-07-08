import type { Message } from '@blade-ai/ai/chat';
import {
  shouldEmitAgentLoopNonStreamingToolResultEffects,
  type AgentFunctionToolCall,
} from './planToolExecution.js';
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
