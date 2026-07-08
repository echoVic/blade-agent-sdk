import type {
  ChatResponse,
  Message,
  ToolCall,
} from '@blade-ai/ai/chat';

export interface AgentLoopAssistantMessageHookPayload {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  turn: number;
}

export interface AgentLoopAssistantMessageProjection {
  message: Message;
  hookPayload: AgentLoopAssistantMessageHookPayload;
}

export interface AgentLoopAssistantMessageProjectionInput {
  response: Pick<ChatResponse, 'content' | 'reasoningContent' | 'toolCalls'>;
  turn: number;
}

export function assertAgentLoopTurnResponse<TResponse>(
  response: TResponse | undefined,
): TResponse {
  if (!response) {
    throw new Error('Agent loop completed without a chat response');
  }

  return response;
}

export function buildAgentLoopAssistantMessageProjection(
  input: AgentLoopAssistantMessageProjectionInput,
): AgentLoopAssistantMessageProjection {
  const content = input.response.content || '';
  const toolCalls = input.response.toolCalls && input.response.toolCalls.length > 0
    ? input.response.toolCalls
    : undefined;

  return {
    message: {
      role: 'assistant',
      content,
      ...(input.response.reasoningContent
        ? { reasoningContent: input.response.reasoningContent }
        : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
    hookPayload: {
      content,
      ...(input.response.reasoningContent
        ? { reasoningContent: input.response.reasoningContent }
        : {}),
      ...(toolCalls ? { toolCalls } : {}),
      turn: input.turn,
    },
  };
}
