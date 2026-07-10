import type { JSONSchema7 } from 'json-schema';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamToolCall,
} from '@blade-ai/ai/chat';

export type StreamChatResponseDelta =
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string };

interface ToolCallAccumulatorEntry {
  id: string;
  name: string;
  arguments: string;
}

export async function* streamChatResponse(
  getChatService: () => IChatService,
  messages: readonly Message[],
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
  signal?: AbortSignal,
  logger?: InternalLogger,
): AsyncGenerator<StreamChatResponseDelta, ChatResponse> {
  const log = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  const chatService = getChatService();
  let fullContent = '';
  let fullReasoningContent = '';
  let streamUsage: ChatResponse['usage'];
  const toolCallAccumulator = new Map<number, ToolCallAccumulatorEntry>();

  try {
    const stream = chatService.streamChat(messages, tools, signal);
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount += 1;
      if (signal?.aborted) break;

      if (chunk.content) {
        fullContent += chunk.content;
        yield { type: 'content_delta', delta: chunk.content };
      }

      if (chunk.reasoningContent) {
        fullReasoningContent += chunk.reasoningContent;
        yield { type: 'thinking_delta', delta: chunk.reasoningContent };
      }

      if (chunk.usage) {
        streamUsage = chunk.usage;
      }

      if (chunk.toolCalls) {
        for (const toolCall of chunk.toolCalls) {
          accumulateToolCall(toolCallAccumulator, toolCall);
        }
      }

      if (chunk.finishReason) {
        break;
      }
    }

    if (
      chunkCount === 0
      && !signal?.aborted
      && fullContent.length === 0
      && toolCallAccumulator.size === 0
    ) {
      log.warn('[Agent] Streaming response returned 0 chunks; falling back to non-streaming mode');
      return chatService.chat(messages, tools, signal);
    }

    return {
      content: fullContent,
      reasoningContent: fullReasoningContent || undefined,
      toolCalls: buildFinalToolCalls(toolCallAccumulator),
      usage: streamUsage,
    };
  } catch (error) {
    if (isStreamingNotSupportedError(error)) {
      log.warn('[Agent] Streaming request failed; falling back to non-streaming mode');
      return chatService.chat(messages, tools, signal);
    }
    throw error;
  }
}

function accumulateToolCall(
  accumulator: Map<number, ToolCallAccumulatorEntry>,
  chunk: StreamToolCall,
): void {
  const toolCallChunk = chunk as {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  };
  const index = toolCallChunk.index ?? 0;
  let entry = accumulator.get(index);
  if (!entry) {
    entry = {
      id: toolCallChunk.id || '',
      name: toolCallChunk.function?.name || '',
      arguments: '',
    };
    accumulator.set(index, entry);
  }
  if (toolCallChunk.id && !entry.id) entry.id = toolCallChunk.id;
  if (toolCallChunk.function?.name && !entry.name) entry.name = toolCallChunk.function.name;
  if (toolCallChunk.function?.arguments) entry.arguments += toolCallChunk.function.arguments;
}

function buildFinalToolCalls(
  accumulator: Map<number, ToolCallAccumulatorEntry>,
): ChatResponse['toolCalls'] | undefined {
  const toolCalls = Array.from(accumulator.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, toolCall]) => toolCall)
    .filter((toolCall) => toolCall.id && toolCall.name)
    .map((toolCall) => ({
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function isStreamingNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const streamErrors = [
    'stream not supported',
    'streaming is not available',
    'sse not supported',
    'does not support streaming',
  ];

  return streamErrors.some((message) =>
    error.message.toLowerCase().includes(message.toLowerCase()),
  );
}
