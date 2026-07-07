import type { ChatResponse, StreamChunk } from '@blade-ai/ai/chat';
import { describe, expect, it, vi } from 'vitest';
import { streamPackageLocalChatResponse } from '../session/streamChatResponse.js';

async function collectStream(
  stream: AsyncGenerator<
    { type: 'content_delta'; delta: string } | { type: 'thinking_delta'; delta: string },
    ChatResponse
  >,
): Promise<{
  deltas: Array<{ type: 'content_delta' | 'thinking_delta'; delta: string }>;
  response: ChatResponse;
}> {
  const deltas: Array<{ type: 'content_delta' | 'thinking_delta'; delta: string }> = [];

  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { deltas, response: next.value };
    }
    deltas.push(next.value);
  }
}

function createChatService(options: {
  streamChat: () => AsyncGenerator<StreamChunk, void, unknown>;
  fallbackChat?: () => Promise<ChatResponse>;
}) {
  return {
    streamChat: vi.fn(options.streamChat),
    chat: vi.fn(options.fallbackChat ?? (async () => ({ content: 'fallback' }))),
    sideQuery: vi.fn(),
    chatWithRetryEvents: undefined,
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
  };
}

describe('package-local stream chat response collector', () => {
  it('collects content, thinking, usage, and indexed tool-call chunks', async () => {
    const chatService = createChatService({
      streamChat: async function* () {
        yield { content: 'Hel' };
        yield { reasoningContent: 'Think' };
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{"path":',
              },
            },
          ],
        };
        yield {
          toolCalls: [
            {
              index: 0,
              function: {
                arguments: '"a.txt"}',
              },
            },
          ],
          usage: { totalTokens: 7 },
          finishReason: 'tool_calls',
        };
      },
    });

    const result = await collectStream(
      streamPackageLocalChatResponse(
        () => chatService,
        [{ role: 'user', content: 'read' }],
        [{ name: 'ReadFile', description: 'read', parameters: {} }],
      ),
    );

    expect(result.deltas).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'thinking_delta', delta: 'Think' },
    ]);
    expect(result.response).toEqual({
      content: 'Hel',
      reasoningContent: 'Think',
      toolCalls: [
        {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'ReadFile',
            arguments: '{"path":"a.txt"}',
          },
        },
      ],
      usage: { totalTokens: 7 },
    });
  });

  it('falls back to chat when the stream produces no chunks', async () => {
    const chatService = createChatService({
      streamChat: async function* () {},
      fallbackChat: async () => ({ content: 'fallback response' }),
    });

    const result = await collectStream(
      streamPackageLocalChatResponse(
        () => chatService,
        [{ role: 'user', content: 'hello' }],
        [],
      ),
    );

    expect(result.deltas).toEqual([]);
    expect(result.response.content).toBe('fallback response');
    expect(chatService.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back to chat for streaming-not-supported errors only', async () => {
    const chatService = createChatService({
      // biome-ignore lint/correctness/useYield: throws before yielding to model stream consumer
      streamChat: async function* () {
        throw new Error('stream not supported');
      },
      fallbackChat: async () => ({ content: 'fallback response' }),
    });

    const result = await collectStream(
      streamPackageLocalChatResponse(
        () => chatService,
        [{ role: 'user', content: 'hello' }],
        [],
      ),
    );

    expect(result.response.content).toBe('fallback response');
    expect(chatService.chat).toHaveBeenCalledTimes(1);
  });

  it('propagates non-fallback stream errors', async () => {
    const chatService = createChatService({
      // biome-ignore lint/correctness/useYield: throws before yielding to model stream consumer
      streamChat: async function* () {
        throw new Error('maximum context length exceeded');
      },
    });

    await expect(
      collectStream(
        streamPackageLocalChatResponse(
          () => chatService,
          [{ role: 'user', content: 'large' }],
          [],
        ),
      ),
    ).rejects.toThrow('maximum context length exceeded');
    expect(chatService.chat).not.toHaveBeenCalled();
  });
});
