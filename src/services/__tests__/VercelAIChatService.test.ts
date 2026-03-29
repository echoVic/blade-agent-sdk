import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';

const mockOpenAIModelFactory = vi.fn((model: string) => ({ provider: 'openai', model }));
const mockCreateOpenAI = vi.fn((_options?: Record<string, unknown>) => mockOpenAIModelFactory);
const mockCompatibleModelFactory = vi.fn((model: string) => ({ provider: 'compatible', model }));
const mockCreateOpenAICompatible = vi.fn((_options?: Record<string, unknown>) => mockCompatibleModelFactory);

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

const { VercelAIChatService } = await import('../VercelAIChatService.js');

describe('VercelAIChatService', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
    mockOpenAIModelFactory.mockClear();
    mockCreateOpenAICompatible.mockClear();
    mockCompatibleModelFactory.mockClear();
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
});
