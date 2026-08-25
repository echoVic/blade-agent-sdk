import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistryError } from '../../errors/ProviderRegistryError.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelService } from '../../model/service.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { createSession } from '../Session.js';

function createService(initialConfig: ModelServiceConfig): ModelService {
  let config = initialConfig;
  return {
    async chat() {
      return { content: 'custom response' };
    },
    async sideQuery() {
      return { content: 'custom response' };
    },
    async *streamChat() {
      yield { content: 'custom response' };
      yield {
        finishReason: 'stop',
        usage: {
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        },
      };
    },
    getConfig() {
      return config;
    },
    updateConfig(nextConfig) {
      config = { ...config, ...nextConfig };
    },
  };
}

describe('Session provider registry', () => {
  it('runs a Session through a custom provider adapter', async () => {
    const create = vi.fn((config: Readonly<ModelServiceConfig>) => createService({ ...config }));
    const registry = new ProviderRegistry([
      {
        type: 'custom-wire-api',
        create,
      },
    ]);
    const session = await createSession({
      provider: {
        id: 'custom-provider',
        type: 'custom-wire-api',
        apiKey: 'test-key',
        baseUrl: 'https://provider.example.test',
      },
      providerRegistry: registry,
      model: 'custom-model',
      persistSession: false,
      allowedTools: [],
    });

    await session.send('hello');
    const events = [];
    for await (const event of session.stream()) {
      events.push(event);
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'custom-wire-api',
        providerId: 'custom-provider',
        model: 'custom-model',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'content',
        delta: 'custom response',
      }),
    );
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'custom response',
        modelIdentity: {
          provider: 'custom-provider',
          api: 'custom-wire-api',
          model: 'custom-model',
        },
      }),
    );

    await session.close();
  });

  it('fails closed when a custom adapter is not registered', async () => {
    await expect(
      createSession({
        provider: {
          type: 'missing-custom-api',
          apiKey: 'test-key',
        },
        model: 'custom-model',
        persistSession: false,
        allowedTools: [],
      }),
    ).rejects.toBeInstanceOf(ProviderRegistryError);
  });
});
