/**
 * streamChatResponse — 纯流式响应收集
 *
 * 从 StreamResponseHandler 类提取为自由函数。职责：
 * - 从 chatService.streamChat 收集完整 ChatResponse（content / reasoningContent / toolCalls / usage）
 * - 产出 content_delta / thinking_delta 增量事件
 * - 0-chunk 空响应 / streaming-not-supported 错误自动降级到 chatService.chat
 *
 * 没有类成员状态 — 纯 generator。
 */

import type { JSONSchema7 } from 'json-schema';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { streamDebug } from '../../logging/StreamDebugLogger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamToolCall,
} from '../../services/ChatServiceInterface.js';

type StreamDelta =
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string };

interface ToolCallAccumulatorEntry {
  id: string;
  name: string;
  arguments: string;
}

function accumulateToolCall(
  accumulator: Map<number, ToolCallAccumulatorEntry>,
  chunk: StreamToolCall,
): void {
  const tc = chunk as {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  };
  const index = tc.index ?? 0;
  let entry = accumulator.get(index);
  if (!entry) {
    entry = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
    accumulator.set(index, entry);
  }
  if (tc.id && !entry.id) entry.id = tc.id;
  if (tc.function?.name && !entry.name) entry.name = tc.function.name;
  if (tc.function?.arguments) entry.arguments += tc.function.arguments;
}

function buildFinalToolCalls(
  accumulator: Map<number, ToolCallAccumulatorEntry>,
): ChatResponse['toolCalls'] | undefined {
  if (accumulator.size === 0) return undefined;
  return Array.from(accumulator.values())
    .filter((tc) => tc.id && tc.name)
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
}

function isStreamingNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const streamErrors = [
    'stream not supported',
    'streaming is not available',
    'sse not supported',
    'does not support streaming',
  ];
  return streamErrors.some((msg) =>
    error.message.toLowerCase().includes(msg.toLowerCase()),
  );
}

export async function* streamChatResponse(
  getChatService: () => IChatService,
  messages: readonly Message[],
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
  signal?: AbortSignal,
  logger?: InternalLogger,
): AsyncGenerator<StreamDelta, ChatResponse> {
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
      chunkCount++;
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
        for (const tc of chunk.toolCalls) {
          accumulateToolCall(toolCallAccumulator, tc);
        }
      }

      if (chunk.finishReason) {
        streamDebug('streamChatResponse', 'finishReason received', {
          finishReason: chunk.finishReason,
          fullContentLen: fullContent.length,
          fullReasoningContentLen: fullReasoningContent.length,
          toolCallAccumulatorSize: toolCallAccumulator.size,
        });
        break;
      }
    }

    if (
      chunkCount === 0
      && !signal?.aborted
      && fullContent.length === 0
      && toolCallAccumulator.size === 0
    ) {
      log.warn('[Agent] 流式响应返回0个chunk，回退到非流式模式');
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
      log.warn('[Agent] 流式请求失败，降级到非流式模式');
      return chatService.chat(messages, tools, signal);
    }
    throw error;
  }
}
