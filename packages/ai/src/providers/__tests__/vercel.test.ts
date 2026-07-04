import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../model/index.js';

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
const generateText = vi.fn();
const streamText = vi.fn();
const jsonSchema = vi.fn((schema: JsonObject) => ({ kind: 'json-schema', schema }));
const outputObject = vi.fn((config: { schema: unknown }) => ({ kind: 'output-object', ...config }));

vi.mock('@ai-sdk/openai', () => ({ createOpenAI }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic }));
vi.mock('@ai-sdk/azure', () => ({ createAzure }));
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    Output: { object: outputObject },
    generateText,
    jsonSchema,
    streamText,
  };
});

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

  it('creates a ModelPort that normalizes generateText responses', async () => {
    generateText.mockResolvedValue({
      text: 'hello',
      reasoning: [{ text: 'thinking' }],
      toolCalls: [
        {
          toolCallId: 'call_search',
          toolName: 'Search',
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
    const { createVercelModelPort } = await import('../vercel/index.js');

    const port = createVercelModelPort({
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      headers: { 'X-Test': '1' },
    });

    const response = await port.generate({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'Search',
          description: 'Search docs',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        },
      ],
      providerOptions: { openai: { reasoningEffort: 'low' } },
      temperature: 0.2,
      maxOutputTokens: 64,
    });

    expect(openAIModel).toHaveBeenCalledWith('gpt-5-mini');
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      model: { provider: 'openai', model: 'gpt-5-mini' },
      providerOptions: { openai: { reasoningEffort: 'low' } },
      temperature: 0.2,
      tools: {
        Search: {
          description: 'Search docs',
          inputSchema: { kind: 'json-schema', schema: { type: 'object', properties: { q: { type: 'string' } } } },
        },
      },
    }));
    expect(response).toEqual({
      content: 'hello',
      reasoningContent: 'thinking',
      toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
      finishReason: 'stop',
      raw: expect.any(Object),
    });
  });

  it('passes JSON schema outputFormat to generateText as experimental_output', async () => {
    generateText.mockResolvedValue({ text: '{"ok":true}' });
    const { createVercelModelPort } = await import('../vercel/index.js');

    const port = createVercelModelPort({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-5',
    });

    await port.generate({
      messages: [{ role: 'user', content: 'json please' }],
      outputFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'Answer',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });

    expect(outputObject).toHaveBeenCalledWith({
      schema: {
        kind: 'json-schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      experimental_output: {
        kind: 'output-object',
        schema: {
          kind: 'json-schema',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    }));
  });

  it('maps assistant tool calls and tool results into Vercel AI messages', async () => {
    generateText.mockResolvedValue({ text: 'done' });
    const { createVercelModelPort } = await import('../vercel/index.js');

    const port = createVercelModelPort({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-pro',
    });

    await port.generate({
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'need a tool',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'needle' } }],
        },
        {
          role: 'tool',
          name: 'Search',
          toolCallId: 'call_search',
          content: 'found',
        },
      ],
    });

    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'need a tool' },
            {
              type: 'tool-call',
              toolCallId: 'call_search',
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
              toolCallId: 'call_search',
              toolName: 'Search',
              output: { type: 'text', value: 'found' },
            },
          ],
        },
      ],
    }));
  });

  it('applies DeepSeek thinking options and strict tool schemas inside the ModelPort', async () => {
    generateText.mockResolvedValue({ text: 'done' });
    const { createVercelModelPort } = await import('../vercel/index.js');

    const port = createVercelModelPort({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-pro',
    });

    await port.generate({
      messages: [{ role: 'user', content: 'search' }],
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
      providerOptions: {
        deepseek: { strictTools: true },
      },
    });

    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
      tools: {
        Search: expect.objectContaining({
          strict: true,
          inputSchema: expect.objectContaining({
            schema: expect.objectContaining({
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
  });

  it('creates a ModelPort that normalizes streamText events', async () => {
    streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'reasoning-delta', text: 'why' };
        yield { type: 'text-delta', text: 'hi' };
        yield { type: 'tool-call', toolCallId: 'call_search', toolName: 'Search', input: { q: 'blade' } };
        yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      })(),
    });
    const { createVercelModelPort } = await import('../vercel/index.js');

    const port = createVercelModelPort({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-5',
    });

    const events = [];
    for await (const event of port.stream({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
    })) {
      events.push(event);
    }

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(events).toEqual([
      { type: 'reasoning_delta', delta: 'why' },
      { type: 'content_delta', delta: 'hi' },
      { type: 'tool_call', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      {
        type: 'usage',
        usage: {
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        },
      },
      { type: 'done', finishReason: 'tool-calls' },
    ]);
  });
});
