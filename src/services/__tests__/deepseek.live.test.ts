import { describe, expect, it } from 'vitest';
import { createChatServiceAsync } from '../ChatServiceInterface.js';
import { createDeepSeekFimCompletion } from '../deepseek.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? '';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const runLive = process.env.DEEPSEEK_LIVE_TESTS === '1' && apiKey.length > 0;
const describeLive = runLive ? describe : describe.skip;

describeLive('DeepSeek live integration', () => {
  it('runs a basic chat completion through the native provider', async () => {
    const service = await createChatServiceAsync({
      provider: 'deepseek',
      apiKey,
      baseUrl,
      model,
      maxOutputTokens: 64,
      temperature: 0,
    });

    const response = await service.chat([
      { role: 'user', content: 'Reply with exactly: deepseek-ok' },
    ]);

    expect(response.content.toLowerCase()).toContain('deepseek-ok');
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('returns function tool calls from the native provider', async () => {
    const service = await createChatServiceAsync({
      provider: 'deepseek',
      apiKey,
      baseUrl,
      model,
      maxOutputTokens: 128,
      temperature: 0,
    });

    const response = await service.chat(
      [
        {
          role: 'user',
          content: 'Use the get_weather tool for Shanghai with unit celsius.',
        },
      ],
      [
        {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city', 'unit'],
            additionalProperties: false,
          },
        },
      ],
    );

    expect(response.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'get_weather',
      },
    });
  });

  it('streams chat deltas and final usage metadata', async () => {
    const service = await createChatServiceAsync({
      provider: 'deepseek',
      apiKey,
      baseUrl,
      model,
      maxOutputTokens: 64,
      temperature: 0,
    });

    let content = '';
    let usageTotal = 0;
    for await (const chunk of service.streamChat([
      { role: 'user', content: 'Reply with exactly: stream-ok' },
    ])) {
      content += chunk.content ?? '';
      usageTotal = chunk.usage?.totalTokens ?? usageTotal;
    }

    expect(content.toLowerCase()).toContain('stream-ok');
    expect(usageTotal).toBeGreaterThan(0);
  });

  it('runs FIM completion through the beta endpoint', async () => {
    const response = await createDeepSeekFimCompletion({
      apiKey,
      baseUrl: process.env.DEEPSEEK_FIM_BASE_URL,
      model,
      prompt: 'function answer() { return ',
      suffix: '; }',
      maxTokens: 16,
      temperature: 0,
    });

    expect(response.choices.length).toBeGreaterThan(0);
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });
});
