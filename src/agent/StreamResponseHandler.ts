import { createLogger, LogCategory } from '../logging/Logger.js';
import { streamDebug } from '../logging/StreamDebugLogger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamToolCall,
} from '../services/ChatServiceInterface.js';

const logger = createLogger(LogCategory.AGENT);

export class StreamResponseHandler {
  constructor(private getChatService: () => IChatService) {}

  async *streamResponse(
    messages: Message[],
    tools: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): AsyncGenerator<
    { type: 'content_delta'; delta: string } | { type: 'thinking_delta'; delta: string },
    ChatResponse
  > {
    const chatService = this.getChatService();
    let fullContent = '';
    let fullReasoningContent = '';
    let streamUsage: ChatResponse['usage'];
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      const stream = chatService.streamChat(messages, tools, signal);
      let chunkCount = 0;

      for await (const chunk of stream) {
        chunkCount++;
        if (signal?.aborted) {
          break;
        }

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
            this.accumulateToolCall(toolCallAccumulator, tc);
          }
        }

        if (chunk.finishReason) {
          streamDebug('processStreamResponse', 'finishReason received', {
            finishReason: chunk.finishReason,
            fullContentLen: fullContent.length,
            fullReasoningContentLen: fullReasoningContent.length,
            toolCallAccumulatorSize: toolCallAccumulator.size,
          });
          break;
        }
      }

      if (
        chunkCount === 0 &&
        !signal?.aborted &&
        fullContent.length === 0 &&
        toolCallAccumulator.size === 0
      ) {
        logger.warn('[Agent] 流式响应返回0个chunk，回退到非流式模式');
        return chatService.chat(messages, tools, signal);
      }

      return {
        content: fullContent,
        reasoningContent: fullReasoningContent || undefined,
        toolCalls: this.buildFinalToolCalls(toolCallAccumulator),
        usage: streamUsage,
      };
    } catch (error) {
      if (this.isStreamingNotSupportedError(error)) {
        logger.warn('[Agent] 流式请求失败，降级到非流式模式');
        return chatService.chat(messages, tools, signal);
      }
      throw error;
    }
  }

  private accumulateToolCall(
    accumulator: Map<number, { id: string; name: string; arguments: string }>,
    chunk: StreamToolCall
  ): void {
    const tc = chunk as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = tc.index ?? 0;

    if (!accumulator.has(index)) {
      accumulator.set(index, {
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: '',
      });
    }

    const entry = accumulator.get(index)!;

    if (tc.id && !entry.id) entry.id = tc.id;
    if (tc.function?.name && !entry.name) entry.name = tc.function.name;

    if (tc.function?.arguments) {
      entry.arguments += tc.function.arguments;
    }
  }

  private buildFinalToolCalls(
    accumulator: Map<number, { id: string; name: string; arguments: string }>
  ): ChatResponse['toolCalls'] | undefined {
    if (accumulator.size === 0) return undefined;

    return Array.from(accumulator.values())
      .filter((tc) => tc.id && tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
  }

  private isStreamingNotSupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const streamErrors = [
      'stream not supported',
      'streaming is not available',
      'sse not supported',
      'does not support streaming',
    ];

    return streamErrors.some((msg) =>
      error.message.toLowerCase().includes(msg.toLowerCase())
    );
  }
}
