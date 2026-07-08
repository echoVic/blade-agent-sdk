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

export interface AgentLoopAssistantMessageHookContainer {
  message?: {
    onAssistant?: (
      payload: AgentLoopAssistantMessageHookPayload,
    ) => Promise<void> | void;
  } | null;
}

export interface AgentLoopAssistantMessageConversationLike {
  append(...messages: Message[]): void;
}

export interface AgentLoopAssistantMessageProjectionInput {
  response: Pick<ChatResponse, 'content' | 'reasoningContent' | 'toolCalls'>;
  turn: number;
}

export interface ApplyAgentLoopAssistantMessageProjectionInput {
  conversation: AgentLoopAssistantMessageConversationLike;
  projection: AgentLoopAssistantMessageProjection;
}

export interface RunAgentLoopAssistantMessageHookInput {
  projection: AgentLoopAssistantMessageProjection;
  hooks?: AgentLoopAssistantMessageHookContainer | null;
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

export function applyAgentLoopAssistantMessageProjection(
  input: ApplyAgentLoopAssistantMessageProjectionInput,
): AgentLoopAssistantMessageProjection {
  input.conversation.append(input.projection.message);
  return input.projection;
}

export async function runAgentLoopAssistantMessageHook(
  input: RunAgentLoopAssistantMessageHookInput,
): Promise<AgentLoopAssistantMessageProjection> {
  await input.hooks?.message?.onAssistant?.(input.projection.hookPayload);
  return input.projection;
}
