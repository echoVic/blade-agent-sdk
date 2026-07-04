import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../model/index.js';

const compatibleModel = vi.fn((model: string) => ({ id: model, provider: 'mock-compatible' }));
const createOpenAICompatible = vi.fn(() => compatibleModel);
const generateText = vi.fn();
const streamText = vi.fn();
const jsonSchema = vi.fn((schema: JsonObject) => ({ kind: 'json-schema', schema }));
const outputObject = vi.fn((config: { schema: unknown }) => ({ kind: 'output-object', ...config }));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible,
}));

vi.mock('ai', () => ({
  Output: { object: outputObject },
  generateText,
  jsonSchema,
  streamText,
}));

describe('OpenAI-compatible ModelPort adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compatibleModel.mockReturnValue({ id: 'glm-5.2', provider: 'mock-compatible' });
  });

  it('maps ModelRequest to generateText and normalizes ModelResponse', async () => {
    generateText.mockResolvedValue({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'thinking' },
      ],
      reasoningText: 'thinking',
      toolCalls: [
        {
          toolCallId: 'call_1',
          toolName: 'search',
          input: { q: 'blade' },
        },
      ],
      totalUsage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        reasoningTokens: 2,
      },
      finishReason: 'stop',
    });

    const { createOpenAICompatibleModelPort } = await import('../openai-compatible/index.js');
    const port = createOpenAICompatibleModelPort({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'glm-5.2',
      name: 'glm',
      headers: { 'x-test': '1' },
    });

    const response = await port.generate({
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 64,
      providerOptions: { custom: { trace: 'enabled' } },
    });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      headers: { 'x-test': '1' },
      name: 'glm',
    });
    expect(compatibleModel).toHaveBeenCalledWith('glm-5.2');
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 64,
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'hi' },
      ],
      model: { id: 'glm-5.2', provider: 'mock-compatible' },
      providerOptions: { custom: { trace: 'enabled' } },
      temperature: 0.2,
      tools: {
        search: {
          description: 'Search docs',
          inputSchema: { kind: 'json-schema', schema: { type: 'object', properties: { q: { type: 'string' } } } },
        },
      },
    }));
    expect(response).toEqual({
      content: 'hello',
      reasoningContent: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'search', input: { q: 'blade' } }],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        reasoningTokens: 2,
      },
      finishReason: 'stop',
      raw: expect.any(Object),
    });
  });

  it('normalizes streamText parts into ModelStreamEvent values', async () => {
    streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'he' };
        yield { type: 'reasoning-delta', text: 'why' };
        yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'search', input: { q: 'blade' } };
        yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      })(),
    });

    const { createOpenAICompatibleModelPort } = await import('../openai-compatible/index.js');
    const port = createOpenAICompatibleModelPort({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'glm-5.2',
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
      { type: 'content_delta', delta: 'he' },
      { type: 'reasoning_delta', delta: 'why' },
      { type: 'tool_call', toolCall: { id: 'call_1', name: 'search', input: { q: 'blade' } } },
      {
        type: 'usage',
        usage: {
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
        },
      },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('passes JSON schema outputFormat to generateText as experimental_output', async () => {
    generateText.mockResolvedValue({ text: '{"ok":true}' });
    const { createOpenAICompatibleModelPort } = await import('../openai-compatible/index.js');
    const port = createOpenAICompatibleModelPort({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'glm-5.2',
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
    const { createOpenAICompatibleModelPort } = await import('../openai-compatible/index.js');
    const port = createOpenAICompatibleModelPort({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'glm-5.2',
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
});
