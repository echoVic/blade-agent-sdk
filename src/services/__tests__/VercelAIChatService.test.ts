import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';

const mockOpenAIModelFactory = vi.fn((model: string) => ({ provider: 'openai', model }));
const mockCreateOpenAI = vi.fn((_options?: Record<string, unknown>) => mockOpenAIModelFactory);
const mockCompatibleModelFactory = vi.fn((model: string) => ({ provider: 'compatible', model }));
const mockCreateOpenAICompatible = vi.fn((_options?: Record<string, unknown>) => mockCompatibleModelFactory);
const mockDeepSeekModelFactory = vi.fn((model: string) => ({ provider: 'deepseek', model }));
const mockCreateDeepSeek = vi.fn((_options?: Record<string, unknown>) => mockDeepSeekModelFactory);
const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: mockCreateDeepSeek,
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mockGenerateText,
    streamText: mockStreamText,
  };
});

const { VercelAIChatService } = await import('../VercelAIChatService.js');

describe('VercelAIChatService', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
    mockOpenAIModelFactory.mockClear();
    mockCreateOpenAICompatible.mockClear();
    mockCompatibleModelFactory.mockClear();
    mockCreateDeepSeek.mockClear();
    mockDeepSeekModelFactory.mockClear();
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
  });

  it('uses the native OpenAI provider for openai configs', async () => {
    const service = new VercelAIChatService(
      {
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        customHeaders: {
          'X-Test': '1',
        },
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'X-Test': '1',
      },
    });
    expect(mockOpenAIModelFactory).toHaveBeenCalledWith('gpt-5');
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });

  it('uses the native DeepSeek provider for deepseek configs', async () => {
    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-chat',
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;

    expect(mockCreateDeepSeek).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com',
      headers: undefined,
    });
    expect(mockDeepSeekModelFactory).toHaveBeenCalledWith('deepseek-v4-flash');
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });

  it('uses DeepSeek beta endpoint and strict sanitized tools when strictTools is enabled', async () => {
    mockGenerateText.mockResolvedValue({
      text: '',
      toolCalls: [
        {
          id: 'raw-call',
          name: 'Search',
          arguments: '{"q":"needle"}',
        },
        {
          toolCallId: 'sdk-call',
          toolName: 'Read',
          input: '{"path":"README.md"}',
        },
      ],
    });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
        providerOptions: {
          deepseek: { strictTools: true },
        },
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const response = await service.chat(
      [{ role: 'user', content: 'search' }],
      [
        {
          name: 'Search',
          description: 'Search content',
          parameters: {
            type: 'object',
            properties: {
              q: { type: 'string', minLength: 1 },
            },
          },
        },
      ],
    );

    expect(mockCreateDeepSeek).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/beta',
      headers: undefined,
    });
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
      tools: {
        Search: expect.objectContaining({
          strict: true,
          inputSchema: expect.objectContaining({
            jsonSchema: expect.objectContaining({
              required: ['q'],
              additionalProperties: false,
              properties: {
                q: { type: 'string' },
              },
            }),
          }),
        }),
      },
    }));
    expect(response.toolCalls?.[0]).toMatchObject({
      id: 'raw-call',
      function: {
        name: 'Search',
        arguments: '{"q":"needle"}',
      },
    });
    expect(response.toolCalls?.[1]).toMatchObject({
      id: 'sdk-call',
      function: {
        name: 'Read',
        arguments: '{"path":"README.md"}',
      },
    });
  });

  it('normalizes DeepSeek multi-turn tool context before requests', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'done',
    });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    await service.chat([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'need a tool',
        tool_calls: [
          {
            id: 'call_keep',
            type: 'function',
            function: { name: 'Search', arguments: '{"q":"needle"}' },
          },
          {
            id: 'call_drop',
            type: 'function',
            function: { name: 'Read', arguments: '{"path":"missing"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_keep',
        name: 'Search',
        content: 'found',
      },
      {
        role: 'tool',
        tool_call_id: 'orphan',
        name: 'Read',
        content: 'orphaned',
      },
      {
        role: 'assistant',
        content: 'intermediate answer',
        reasoningContent: 'ignored reasoning',
      },
      { role: 'user', content: 'continue' },
    ]);

    const request = mockGenerateText.mock.calls[0]?.[0] as { messages: unknown[] };
    expect(request.messages).toEqual([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need a tool' },
          {
            type: 'tool-call',
            toolCallId: 'call_keep',
            toolName: 'Search',
            input: { q: 'needle' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_keep',
            toolName: 'Search',
            output: { type: 'text', value: 'found' },
          },
        ],
      },
      { role: 'assistant', content: 'intermediate answer' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('normalizes DeepSeek raw and snake_case tool call responses', async () => {
    mockGenerateText.mockResolvedValue({
      text: '',
      tool_calls: [
        {
          tool_call_id: 'snake-call',
          function: {
            name: 'Search',
            arguments: { q: 'needle' },
          },
        },
        {
          id: 'invalid-json',
          name: 'Read',
          arguments: '{"path":',
        },
      ],
    });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const response = await service.chat([{ role: 'user', content: 'search' }]);

    expect(response.toolCalls).toEqual([
      {
        id: 'snake-call',
        type: 'function',
        function: {
          name: 'Search',
          arguments: '{"q":"needle"}',
        },
      },
      {
        id: 'invalid-json',
        type: 'function',
        function: {
          name: 'Read',
          arguments: '{"path":',
        },
      },
    ]);
  });

  it('passes DeepSeek thinking options and maps cache/reasoning usage', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'answer',
      reasoningText: 'think',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        inputTokenDetails: { cacheReadTokens: 7, noCacheTokens: 5 },
        outputTokenDetails: { reasoningTokens: 3 },
      },
      providerMetadata: {
        deepseek: { promptCacheHitTokens: 7, promptCacheMissTokens: 5 },
      },
    });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-reasoner',
        temperature: 0.9,
        supportsThinking: true,
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const response = await service.chat([
      { role: 'user', content: 'hello' },
    ]);

    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
        },
      },
      temperature: undefined,
    }));
    expect(response.reasoningContent).toBe('think');
    expect(response.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      cacheReadInputTokens: 7,
      cacheMissInputTokens: 5,
      billableInputTokens: 5,
      reasoningTokens: 3,
    });
  });

  it('keeps sampling options when DeepSeek thinking is explicitly disabled', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'answer',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
        temperature: 0.4,
        providerOptions: {
          deepseek: {
            thinking: { type: 'disabled' },
          },
        },
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    await service.chat([{ role: 'user', content: 'hello' }]);

    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.4,
      providerOptions: {
        deepseek: {
          thinking: { type: 'disabled' },
        },
      },
    }));
  });

  it('streams DeepSeek reasoning, tool calls, and cache usage metadata', async () => {
    async function* fullStream() {
      yield { type: 'reasoning-delta', textDelta: 'thinking' };
      yield {
        type: 'tool-call',
        toolCallId: 'call_search',
        toolName: 'Search',
        input: { q: 'needle' },
      };
      yield { type: 'text-delta', text: 'done' };
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: {
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          inputTokenDetails: { cacheReadTokens: 14, noCacheTokens: 6 },
          outputTokenDetails: { reasoningTokens: 2 },
        },
        providerMetadata: {
          deepseek: { promptCacheHitTokens: 14, promptCacheMissTokens: 6 },
        },
      };
    }
    mockStreamText.mockReturnValue({ fullStream: fullStream() });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
        providerOptions: {
          deepseek: {
            thinking: { type: 'enabled' },
            strictTools: true,
          },
        },
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const chunks = [];
    for await (const chunk of service.streamChat(
      [{ role: 'user', content: 'search' }],
      [
        {
          name: 'Search',
          description: 'Search content',
          parameters: {
            type: 'object',
            properties: {
              q: { type: 'string', minLength: 1 },
            },
          },
        },
      ],
    )) {
      chunks.push(chunk);
    }

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
        },
      },
      temperature: undefined,
      tools: {
        Search: expect.objectContaining({
          strict: true,
        }),
      },
    }));
    expect(chunks).toEqual([
      { reasoningContent: 'thinking' },
      {
        toolCalls: [
          {
            index: 0,
            id: 'call_search',
            type: 'function',
            function: {
              name: 'Search',
              arguments: '{"q":"needle"}',
            },
          },
        ],
      },
      { content: 'done' },
      {
        finishReason: 'tool-calls',
        usage: {
          promptTokens: 20,
          completionTokens: 4,
          totalTokens: 24,
          cacheReadInputTokens: 14,
          cacheMissInputTokens: 6,
          billableInputTokens: 6,
          reasoningTokens: 2,
        },
      },
    ]);
  });

  it('streams DeepSeek delta fields and preserves JSON-string tool inputs', async () => {
    async function* fullStream() {
      yield { type: 'reasoning-delta', delta: 'think' };
      yield {
        type: 'tool-call',
        tool_call_id: 'call_read',
        name: 'Read',
        arguments: '{"path":"README.md"}',
      };
      yield { type: 'text-delta', delta: 'done' };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    mockStreamText.mockReturnValue({ fullStream: fullStream() });

    const service = new VercelAIChatService(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-v4-pro',
        providerOptions: {
          deepseek: {
            thinking: { type: 'enabled' },
          },
        },
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const chunks = [];
    for await (const chunk of service.streamChat(
      [{ role: 'user', content: 'read' }],
      [
        {
          name: 'Read',
          description: 'Read file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { reasoningContent: 'think' },
      {
        toolCalls: [
          {
            index: 0,
            id: 'call_read',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      },
      { content: 'done' },
      { finishReason: 'tool-calls', usage: undefined },
    ]);
  });
});
