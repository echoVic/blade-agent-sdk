import type {
  Message,
  ToolCall,
} from '@blade-ai/ai/chat';
import {
  buildAgentToolResultContent,
  type AgentToolResultContentInput,
} from './toolResultContent.js';

export interface AgentLoopToolMessageInput {
  toolCall: ToolCall;
  result: AgentToolResultContentInput;
}

export function buildAgentLoopToolMessage(input: AgentLoopToolMessageInput): Message {
  return {
    role: 'tool',
    tool_call_id: input.toolCall.id,
    name: input.toolCall.function.name,
    content: buildAgentToolResultContent(input.result),
  };
}
