import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';

const mockOpenAIModelFactory = vi.fn((model: string) => ({ provider: 'openai', model }));
const mockCreateOpenAI = vi.fn((_options?: Record<string, unknown>) => mockOpenAIModelFactory);
const mockCompatibleModelFactory = vi.fn((model: string) => ({ provider: 'compatible', model }));
const mockCreateOpenAICompatible = vi.fn((_options?: Record<string, unknown>) => mockCompatibleModelFactory);
const mockDeepSeekModelFactory = vi.fn((model: string) => ({ provider: 'deepseek', model }));
const mockCreateDeepSeek = vi.fn((_options?: Record<string, unknown>) => mockDeepSeekModelFactory);
const mockGenerateText = vi.fn();

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

  it('passes DeepSeek thinking options and maps cache/reasoning usage', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'answer',
      reasoningText: 'think',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        inputTokenDetails: { cacheReadTokens: 7 },
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
});
