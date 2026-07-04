import { describe, expect, it } from 'vitest';
import {
  buildBladeConfig,
  buildSessionModelConfig,
  getDefaultProviderBaseUrl,
  mapSessionProviderType,
} from '../../packages/agent-sdk/src/session/config.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';

describe('agent-sdk package-local session config builder', () => {
  it('builds model and blade config from session options without root Session helpers', () => {
    const providerOptions = {
      openai: {
        reasoningEffort: 'low',
      },
    };
    const options = {
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        headers: {
          'X-Test': '1',
        },
        organization: 'org-test',
        projectId: 'proj-test',
      },
      model: 'gpt-5',
      temperature: 0.2,
      maxOutputTokens: 4096,
      maxContextTokens: 32000,
      providerOptions,
      thinkingEnabled: true,
      thinkingBudget: 1024,
    } satisfies SessionOptions;

    expect(buildSessionModelConfig(options)).toEqual({
      id: 'default',
      name: 'gpt-5',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      headers: {
        'X-Test': '1',
        'OpenAI-Organization': 'org-test',
        'OpenAI-Project': 'proj-test',
      },
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      temperature: 0.2,
      providerOptions,
      thinkingEnabled: true,
      thinkingBudget: 1024,
    });
    expect(buildBladeConfig(options)).toEqual({
      models: [
        expect.objectContaining({
          model: 'gpt-5',
          provider: 'openai',
        }),
      ],
      currentModelId: 'default',
      temperature: 0.2,
      permissions: {
        allow: [],
        deny: [],
      },
    });
  });

  it('normalizes provider defaults for openai-compatible session models', () => {
    expect(mapSessionProviderType('not-real')).toBe('openai-compatible');
    expect(getDefaultProviderBaseUrl('deepseek')).toBe('https://api.deepseek.com');
    expect(
      buildSessionModelConfig({
        provider: {
          type: 'openai-compatible',
          apiKey: 'test-key',
        },
        model: 'glm-5.2',
      }),
    ).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      maxContextTokens: 128000,
    });
  });
});
