import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistryError } from '../../errors/ProviderRegistryError.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import {
  type ChatConfig,
  createChatServiceAsync,
  type IChatService,
} from '../ChatServiceInterface.js';
import {
  type ProviderAdapter,
  ProviderRegistry,
} from '../ProviderRegistry.js';

function config(provider = 'custom-api'): ChatConfig {
  return {
    provider,
    providerId: 'logical-provider',
    apiKey: 'test-key',
    baseUrl: 'https://provider.example.test/v1',
    model: 'test-model',
  };
}

function service(chatConfig: ChatConfig): IChatService {
  return {
    async chat() {
      return { content: 'ok' };
    },
    async sideQuery() {
      return { content: 'ok' };
    },
    async *streamChat() {
      yield { content: 'ok' };
    },
    getConfig() {
      return chatConfig;
    },
    updateConfig() {},
  };
}

describe('ProviderRegistry', () => {
  it('creates a service through a registered custom adapter', async () => {
    const create = vi.fn((chatConfig: Readonly<ChatConfig>) =>
      service({ ...chatConfig }));
    const registry = new ProviderRegistry([
      { type: 'custom-api', create },
    ]);
    const chatConfig = config();

    const result = await registry.create(chatConfig);

    expect(result.getConfig()).toEqual(chatConfig);
    expect(create).toHaveBeenCalledWith(chatConfig);
    expect(registry.has('custom-api')).toBe(true);
    expect(registry.get('custom-api')).toBeDefined();
    expect(registry.list().map((adapter) => adapter.type)).toEqual(['custom-api']);
  });

  it('rejects duplicate and malformed adapters', () => {
    const adapter: ProviderAdapter = {
      type: 'custom-api',
      create: (chatConfig) => service({ ...chatConfig }),
    };

    expect(() => new ProviderRegistry([adapter, adapter])).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_ADAPTER_DUPLICATE',
        providerType: 'custom-api',
      }),
    );
    expect(() =>
      new ProviderRegistry([
        {
          ...adapter,
          type: ' custom-api ',
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_ADAPTER_INVALID',
      }),
    );
  });

  it('fails closed for missing adapters and malformed services', async () => {
    await expect(new ProviderRegistry().create(config())).rejects.toMatchObject({
      code: 'PROVIDER_ADAPTER_NOT_FOUND',
      providerType: 'custom-api',
    });

    const registry = new ProviderRegistry([
      {
        type: 'custom-api',
        create: () => ({}) as IChatService,
      },
    ]);
    await expect(registry.create(config())).rejects.toMatchObject({
      code: 'PROVIDER_ADAPTER_INVALID',
      providerType: 'custom-api',
    });
  });

  it('routes custom and built-in overrides before the default adapter', async () => {
    const customService = service(config());
    const customRegistry = new ProviderRegistry([
      {
        type: 'custom-api',
        create: () => customService,
      },
    ]);

    await expect(
      createChatServiceAsync(config(), NOOP_LOGGER, customRegistry),
    ).resolves.toBe(customService);

    const overrideService = service(config('openai'));
    const overrideRegistry = new ProviderRegistry([
      {
        type: 'openai',
        create: () => overrideService,
      },
    ]);
    await expect(
      createChatServiceAsync(config('openai'), NOOP_LOGGER, overrideRegistry),
    ).resolves.toBe(overrideService);
  });

  it('keeps adapters isolated between registry instances', async () => {
    const firstService = service(config());
    const secondService = service(config());
    const first = new ProviderRegistry([
      {
        type: 'custom-api',
        create: () => firstService,
      },
    ]);
    const second = new ProviderRegistry([
      {
        type: 'custom-api',
        create: () => secondService,
      },
    ]);

    await expect(first.create(config())).resolves.toBe(firstService);
    await expect(second.create(config())).resolves.toBe(secondService);
  });

  it('rejects an unknown adapter when no registry entry exists', async () => {
    await expect(
      createChatServiceAsync(config(), NOOP_LOGGER),
    ).rejects.toBeInstanceOf(ProviderRegistryError);
  });
});
