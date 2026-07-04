import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAIModel = vi.fn((model: string) => ({ provider: 'openai', model }));
const createOpenAI = vi.fn(() => openAIModel);
const anthropicModel = vi.fn((model: string) => ({ provider: 'anthropic', model }));
const createAnthropic = vi.fn(() => anthropicModel);
const azureModel = vi.fn((model: string) => ({ provider: 'azure', model }));
const createAzure = vi.fn(() => azureModel);
const deepSeekModel = vi.fn((model: string) => ({ provider: 'deepseek', model }));
const createDeepSeek = vi.fn(() => deepSeekModel);
const googleModel = vi.fn((model: string) => ({ provider: 'google', model }));
const createGoogleGenerativeAI = vi.fn(() => googleModel);
const compatibleModel = vi.fn((model: string) => ({ provider: 'compatible', model }));
const createOpenAICompatible = vi.fn(() => compatibleModel);

vi.mock('@ai-sdk/openai', () => ({ createOpenAI }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic }));
vi.mock('@ai-sdk/azure', () => ({ createAzure }));
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

describe('Vercel AI provider factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates native OpenAI language models with custom headers', async () => {
    const { createVercelLanguageModel } = await import('../vercel/index.js');

    const model = createVercelLanguageModel({
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      headers: { 'X-Test': '1' },
    });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      headers: { 'X-Test': '1' },
    });
    expect(openAIModel).toHaveBeenCalledWith('gpt-5');
    expect(model).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  it('normalizes DeepSeek models and selects the beta endpoint for strict tools', async () => {
    const { createVercelLanguageModel } = await import('../vercel/index.js');

    createVercelLanguageModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: '',
      model: 'deepseek-chat',
      headers: { 'X-Test': '1' },
      providerOptions: {
        deepseek: { strictTools: true },
      },
    });

    expect(createDeepSeek).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/beta',
      headers: { 'X-Test': '1' },
    });
    expect(deepSeekModel).toHaveBeenCalledWith('deepseek-v4-flash');
  });

  it('uses Azure native resource config when the endpoint is an Azure resource host', async () => {
    const { createVercelLanguageModel } = await import('../vercel/index.js');

    createVercelLanguageModel({
      provider: 'azure-openai',
      apiKey: 'test-key',
      baseUrl: 'https://blade.openai.azure.com',
      model: 'gpt-4.1',
      apiVersion: '2024-10-21',
    });

    expect(createAzure).toHaveBeenCalledWith({
      apiKey: 'test-key',
      resourceName: 'blade',
      apiVersion: '2024-10-21',
    });
    expect(azureModel).toHaveBeenCalledWith('gpt-4.1');
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('falls back to OpenAI-compatible providers for custom provider ids', async () => {
    const { createVercelLanguageModel } = await import('../vercel/index.js');

    createVercelLanguageModel({
      provider: 'openai-compatible',
      providerId: 'glm',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'glm-5.2',
      headers: { 'X-Test': '1' },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'glm',
      apiKey: 'test-key',
      baseURL: 'https://gateway.example.test/v1',
      headers: { 'X-Test': '1' },
    });
    expect(compatibleModel).toHaveBeenCalledWith('glm-5.2');
  });
});
