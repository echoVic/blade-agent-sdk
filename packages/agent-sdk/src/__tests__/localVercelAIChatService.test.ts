import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../local/Logger.js';

const mockOpenAIModelFactory = vi.fn((model: string) => ({ provider: 'openai', model }));
const mockCreateOpenAI = vi.fn((_options?: Record<string, unknown>) => mockOpenAIModelFactory);
const mockCompatibleModelFactory = vi.fn((model: string) => ({ provider: 'compatible', model }));
const mockCreateOpenAICompatible = vi.fn((_options?: Record<string, unknown>) => mockCompatibleModelFactory);
const mockDeepSeekModelFactory = vi.fn((model: string) => ({ provider: 'deepseek', model }));
const mockCreateDeepSeek = vi.fn((_options?: Record<string, unknown>) => mockDeepSeekModelFactory);
const mockModelPortGenerate = vi.fn();
const mockModelPortStream = vi.fn();
const { mockCreateOpenAICompatibleModelPort } = vi.hoisted(() => ({
  mockCreateOpenAICompatibleModelPort: vi.fn(() => ({
    generate: mockModelPortGenerate,
    stream: mockModelPortStream,
  })),
}));
const { mockCreateVercelModelPort } = vi.hoisted(() => ({
  mockCreateVercelModelPort: vi.fn(() => ({
    generate: mockModelPortGenerate,
    stream: mockModelPortStream,
  })),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: mockCreateDeepSeek,
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

vi.mock('@blade-ai/ai/providers/openai-compatible', () => ({
  createOpenAICompatibleModelPort: mockCreateOpenAICompatibleModelPort,
}));

vi.mock('@blade-ai/ai/providers/vercel', () => ({
  createVercelModelPort: mockCreateVercelModelPort,
}));

const { VercelAIChatService } = await import('../local/vercelAIChatService.js');

describe('VercelAIChatService', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
    mockOpenAIModelFactory.mockClear();
    mockCreateOpenAICompatible.mockClear();
    mockCompatibleModelFactory.mockClear();
    mockCreateDeepSeek.mockClear();
    mockDeepSeekModelFactory.mockClear();
    mockCreateOpenAICompatibleModelPort.mockClear();
    mockCreateVercelModelPort.mockClear();
    mockModelPortGenerate.mockReset();
    mockModelPortStream.mockReset();
  });

  it('delegates OpenAI provider creation to the AI Vercel ModelPort factory', async () => {
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

    expect(mockCreateVercelModelPort).toHaveBeenCalledWith({
      provider: 'openai',
      providerId: undefined,
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      headers: {
        'X-Test': '1',
      },
      apiVersion: undefined,
      providerOptions: undefined,
    });
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });

  it('delegates DeepSeek provider creation to the AI Vercel ModelPort factory', async () => {
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

    expect(mockCreateVercelModelPort).toHaveBeenCalledWith({
      provider: 'deepseek',
      providerId: undefined,
      apiKey: 'test-key',
      baseUrl: '',
      model: 'deepseek-chat',
      headers: undefined,
      apiVersion: undefined,
      providerOptions: undefined,
    });
    expect(mockCreateDeepSeek).not.toHaveBeenCalled();
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });

  it('delegates OpenAI-compatible chat requests to the AI ModelPort adapter', async () => {
    mockModelPortGenerate.mockResolvedValue({
      content: 'hello',
      reasoningContent: 'thinking',
      toolCalls: [
        {
          id: 'call_search',
          name: 'Search',
          input: { q: 'blade' },
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
      finishReason: 'stop',
    });

    const service = new VercelAIChatService(
      {
        provider: 'openai-compatible',
        providerId: 'glm',
        apiKey: 'test-key',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'glm-5.2',
        temperature: 0.2,
        maxOutputTokens: 64,
        customHeaders: { 'X-Test': '1' },
        providerOptions: { custom: { trace: 'enabled' } } as never,
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const response = await service.chat(
      [{ role: 'user', content: 'hello' }],
      [
        {
          name: 'Search',
          description: 'Search docs',
          parameters: {
            type: 'object',
            properties: {
              q: { type: 'string' },
            },
          },
        },
      ],
    );

    expect(mockCreateOpenAICompatibleModelPort).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      headers: { 'X-Test': '1' },
      model: 'glm-5.2',
      name: 'glm',
    });
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
    expect(mockModelPortGenerate).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
      model: 'glm-5.2',
      provider: 'openai-compatible',
      providerOptions: { custom: { trace: 'enabled' } },
      temperature: 0.2,
      tools: [
        {
          name: 'Search',
          description: 'Search docs',
          parameters: {
            type: 'object',
            properties: {
              q: { type: 'string' },
            },
          },
        },
      ],
    }));
    expect(response).toEqual({
      content: 'hello',
      reasoningContent: 'thinking',
      toolCalls: [
        {
          id: 'call_search',
          type: 'function',
          function: {
            name: 'Search',
            arguments: '{"q":"blade"}',
          },
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
    });
  });

  it('delegates OpenAI-compatible stream requests to the AI ModelPort adapter', async () => {
    mockModelPortStream.mockReturnValue((async function* () {
      yield { type: 'reasoning_delta', delta: 'think' };
      yield { type: 'content_delta', delta: 'done' };
      yield { type: 'tool_call', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } };
      yield { type: 'usage', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      yield { type: 'done', finishReason: 'tool-calls' };
    })());

    const service = new VercelAIChatService(
      {
        provider: 'openai-compatible',
        providerId: 'glm',
        apiKey: 'test-key',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'glm-5.2',
        maxOutputTokens: 32,
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    const chunks = [];
    for await (const chunk of service.streamChat([{ role: 'user', content: 'hello' }])) {
      chunks.push(chunk);
    }

    expect(mockModelPortStream).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      model: 'glm-5.2',
      provider: 'openai-compatible',
    }));
    expect(chunks).toEqual([
      { reasoningContent: 'think' },
      { content: 'done' },
      {
        toolCalls: [
          {
            index: 0,
            id: 'call_search',
            type: 'function',
            function: {
              name: 'Search',
              arguments: '{"q":"blade"}',
            },
          },
        ],
      },
      {
        usage: {
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        },
      },
      { finishReason: 'tool-calls' },
    ]);
  });

  it('passes structured output format through ModelPort requests', async () => {
    mockModelPortGenerate.mockResolvedValue({
      content: '{"ok":true}',
    });

    const outputFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'Answer',
        schema: {
          type: 'object' as const,
          properties: {
            ok: { type: 'boolean' as const },
          },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    };

    const service = new VercelAIChatService(
      {
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        outputFormat,
      },
      NOOP_LOGGER,
    );

    await (service as unknown as { initialized: Promise<void> }).initialized;
    await service.chat([{ role: 'user', content: 'json please' }]);

    expect(mockModelPortGenerate).toHaveBeenCalledWith(expect.objectContaining({
      outputFormat,
    }));
  });

  it('delegates DeepSeek strict tool config through the AI Vercel ModelPort', async () => {
    mockModelPortGenerate.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'raw-call',
          name: 'Search',
          input: { q: 'needle' },
        },
        {
          id: 'sdk-call',
          name: 'Read',
          input: { path: 'README.md' },
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

    expect(mockCreateVercelModelPort).toHaveBeenCalledWith({
      provider: 'deepseek',
      providerId: undefined,
      apiKey: 'test-key',
      baseUrl: '',
      model: 'deepseek-v4-pro',
      headers: undefined,
      apiVersion: undefined,
      providerOptions: {
        deepseek: { strictTools: true },
      },
    });
    expect(mockModelPortGenerate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'deepseek',
      providerOptions: { deepseek: { strictTools: true } },
      tools: [
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
    mockModelPortGenerate.mockResolvedValue({
      content: 'done',
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

    const request = mockModelPortGenerate.mock.calls[0]?.[0] as { messages: unknown[] };
    expect(request.messages).toEqual([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'need a tool',
        toolCalls: [
          { id: 'call_keep', name: 'Search', input: { q: 'needle' } },
        ],
      },
      {
        role: 'tool',
        content: 'found',
        name: 'Search',
        toolCallId: 'call_keep',
      },
      { role: 'assistant', content: 'intermediate answer' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('maps ModelPort tool calls to chat function tool calls', async () => {
    mockModelPortGenerate.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'search-call',
          name: 'Search',
          input: { q: 'needle' },
        },
        {
          id: 'read-call',
          name: 'Read',
          input: { path: 'README.md' },
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
        id: 'search-call',
        type: 'function',
        function: {
          name: 'Search',
          arguments: '{"q":"needle"}',
        },
      },
      {
        id: 'read-call',
        type: 'function',
        function: {
          name: 'Read',
          arguments: '{"path":"README.md"}',
        },
      },
    ]);
  });

  it('omits sampling for DeepSeek thinking models and maps cache/reasoning usage', async () => {
    mockModelPortGenerate.mockResolvedValue({
      content: 'answer',
      reasoningContent: 'think',
      usage: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
        cacheReadInputTokens: 7,
        cacheMissInputTokens: 5,
        billableInputTokens: 5,
        reasoningTokens: 3,
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

    expect(mockCreateVercelModelPort).toHaveBeenCalledWith(expect.objectContaining({
      supportsThinking: true,
    }));
    expect(mockModelPortGenerate).toHaveBeenCalledWith(expect.objectContaining({
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
    mockModelPortGenerate.mockResolvedValue({
      content: 'answer',
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

    expect(mockModelPortGenerate).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.4,
      providerOptions: {
        deepseek: {
          thinking: { type: 'disabled' },
        },
      },
    }));
  });

  it('streams DeepSeek reasoning, tool calls, and cache usage metadata', async () => {
    mockModelPortStream.mockReturnValue((async function* () {
      yield { type: 'reasoning_delta', delta: 'thinking' };
      yield {
        type: 'tool_call',
        toolCall: { id: 'call_search', name: 'Search', input: { q: 'needle' } },
      };
      yield { type: 'content_delta', delta: 'done' };
      yield {
        type: 'usage',
        usage: {
          promptTokens: 20,
          completionTokens: 4,
          totalTokens: 24,
          cacheReadInputTokens: 14,
          cacheMissInputTokens: 6,
          billableInputTokens: 6,
          reasoningTokens: 2,
        },
      };
      yield { type: 'done', finishReason: 'tool-calls' };
    })());

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

    expect(mockModelPortStream).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          strictTools: true,
        },
      },
      temperature: undefined,
      tools: [
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
      { finishReason: 'tool-calls' },
    ]);
  });

  it('maps ModelPort stream events to chat stream chunks', async () => {
    mockModelPortStream.mockReturnValue((async function* () {
      yield { type: 'reasoning_delta', delta: 'think' };
      yield {
        type: 'tool_call',
        toolCall: { id: 'call_read', name: 'Read', input: { path: 'README.md' } },
      };
      yield { type: 'content_delta', delta: 'done' };
      yield { type: 'done', finishReason: 'tool-calls' };
    })());

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
      { finishReason: 'tool-calls' },
    ]);
  });
});
