import { describe, expect, it } from 'vitest';
import type { ModelPort } from '@blade-ai/ai';
import { createPackageLocalKernelModelResolver } from '../../packages/agent-sdk/src/session/kernelModelResolver.js';
import type { BladeConfig } from '../../packages/agent-sdk/src/types/common.js';

const modelPort: ModelPort = {
  async generate() {
    return { content: 'ok' };
  },
  async *stream() {},
};

const config: BladeConfig = {
  currentModelId: 'primary',
  temperature: 0.8,
  models: [
    {
      id: 'primary',
      name: 'Primary model',
      provider: 'openai-compatible',
      model: 'glm-5.2',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      headers: { 'X-Test': 'yes' },
      maxContextTokens: 128000,
      maxOutputTokens: 2048,
      providerOptions: { routing: { tier: 'gold' } },
      supportsThinking: true,
    },
    {
      id: 'fallback',
      name: 'Fallback model',
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'openai-key',
    },
  ],
};

describe('agent-sdk package-local kernel model resolver', () => {
  it('resolves configured models into ModelPort and request defaults', () => {
    const createCalls: unknown[] = [];
    const resolver = createPackageLocalKernelModelResolver({
      createModelPort(options) {
        createCalls.push(options);
        return modelPort;
      },
    });

    const resolved = resolver.resolve({ bladeConfig: config });

    expect(resolved).toEqual({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        temperature: 0.8,
        maxOutputTokens: 2048,
        maxContextTokens: 128000,
        providerOptions: { routing: { tier: 'gold' } },
      },
    });
    expect(createCalls).toEqual([
      {
        provider: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'glm-5.2',
        headers: { 'X-Test': 'yes' },
        providerOptions: { routing: { tier: 'gold' } },
        supportsThinking: true,
      },
    ]);
  });

  it('resolves explicit model ids and reports missing models clearly', () => {
    const resolver = createPackageLocalKernelModelResolver({
      createModelPort() {
        return modelPort;
      },
    });

    expect(
      resolver.resolve({ bladeConfig: config, modelId: 'fallback' }).modelRequestDefaults,
    ).toMatchObject({
      model: 'gpt-5-mini',
      temperature: 0.8,
    });
    expect(() => resolver.resolve({ bladeConfig: config, modelId: 'missing' })).toThrow(
      'Model configuration not found: missing',
    );
  });
});
