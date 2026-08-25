import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistryError } from '../../errors/ProviderRegistryError.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelService } from '../../model/service.js';
import { createModelService } from '../createModelService.js';
import { type ProviderAdapter, ProviderRegistry } from '../ProviderRegistry.js';

function config(provider = 'custom-api'): ModelServiceConfig {
  return {
    provider,
    providerId: 'logical-provider',
    apiKey: 'test-key',
    baseUrl: 'https://provider.example.test/v1',
    model: 'test-model',
  };
}

function service(modelConfig: ModelServiceConfig): ModelService {
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
      return modelConfig;
    },
    updateConfig() {},
  };
}

describe('ProviderRegistry', () => {
  it('creates a service through a registered custom adapter', async () => {
    const create = vi.fn((modelConfig: Readonly<ModelServiceConfig>) =>
      service({ ...modelConfig }),
    );
    const registry = new ProviderRegistry([{ type: 'custom-api', create }]);
    const modelConfig = config();

    const result = await registry.create(modelConfig);

    expect(result.getConfig()).toEqual(modelConfig);
    expect(create).toHaveBeenCalledWith(modelConfig);
    expect(registry.has('custom-api')).toBe(true);
    expect(registry.get('custom-api')).toBeDefined();
    expect(registry.list().map((adapter) => adapter.type)).toEqual(['custom-api']);
  });

  it('rejects duplicate and malformed adapters', () => {
    const adapter: ProviderAdapter = {
      type: 'custom-api',
      create: (modelConfig) => service({ ...modelConfig }),
    };

    expect(() => new ProviderRegistry([adapter, adapter])).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_ADAPTER_DUPLICATE',
        providerType: 'custom-api',
      }),
    );
    expect(
      () =>
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
        create: () => ({}) as ModelService,
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

    await expect(createModelService(config(), NOOP_LOGGER, customRegistry)).resolves.toBe(
      customService,
    );

    const overrideService = service(config('openai'));
    const overrideRegistry = new ProviderRegistry([
      {
        type: 'openai',
        create: () => overrideService,
      },
    ]);
    await expect(createModelService(config('openai'), NOOP_LOGGER, overrideRegistry)).resolves.toBe(
      overrideService,
    );
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
    await expect(createModelService(config(), NOOP_LOGGER)).rejects.toBeInstanceOf(
      ProviderRegistryError,
    );
  });
});
