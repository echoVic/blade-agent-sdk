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
