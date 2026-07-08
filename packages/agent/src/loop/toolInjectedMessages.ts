import {
  markToolInjectedSystemMessages,
  type ToolInjectedMessageLike,
} from '../state/toolInjectedMessages.js';

export interface AgentLoopToolInjectedMessagesInput<TMessage extends ToolInjectedMessageLike> {
  newMessages?: readonly TMessage[];
}

export function buildAgentLoopToolInjectedMessages<TMessage extends ToolInjectedMessageLike>(
  input: AgentLoopToolInjectedMessagesInput<TMessage>,
): TMessage[] {
  if (!input.newMessages || input.newMessages.length === 0) {
    return [];
  }

  return markToolInjectedSystemMessages(input.newMessages);
}
