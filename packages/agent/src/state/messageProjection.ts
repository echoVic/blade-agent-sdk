import type {
  ModelMessage,
  ModelResponse,
} from '@blade-ai/ai';
import type { AgentToolResult } from '../protocol/index.js';

export interface AgentToolCallIdentity {
  id: string;
  name: string;
}

export function modelResponseToAssistantMessage(
  response: ModelResponse,
): ModelMessage {
  return {
    role: 'assistant',
    content: response.content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
  };
}

export function toolResultToToolMessage(
  result: AgentToolResult,
  toolCall: AgentToolCallIdentity,
): ModelMessage {
  return {
    role: 'tool',
    content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
    name: result.name || toolCall.name,
    toolCallId: result.id || toolCall.id,
  };
}
