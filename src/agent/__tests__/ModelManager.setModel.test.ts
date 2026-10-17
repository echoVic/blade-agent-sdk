import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ModelServiceConfig } from '../../model/config.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import type { BladeConfig } from '../config.js';

const mockCreateModelServiceAsync = vi.fn(
  async (config: ModelServiceConfig, _logger?: unknown, _providerRegistry?: ProviderRegistry) => ({
    chat: vi.fn(async () => ({ content: 'ok' })),
    streamChat: vi.fn(async function* () {}),
    getConfig: () => config,
    updateConfig: vi.fn(() => {}),
  }),
);

vi.mock('../../services/createModelService.js', () => ({
  createModelService: mockCreateModelServiceAsync,
}));

const { ModelManager } = await import('../ModelManager.js');

function createModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'default',
    name: 'gpt-4o-mini',
    model: 'gpt-4o-mini',
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    maxContextTokens: 128000,
    ...overrides,
  };
}

describe('ModelManager.setModel', () => {
  it('passes model output and timeout limits into chat service config', async () => {
    const config: BladeConfig = {
      models: [
        createModelConfig({
          providerId: 'gateway-primary',
          maxOutputTokens: 4096,
          requestTimeoutMs: 120_000,
          streamIdleTimeoutMs: 30_000,
        }),
      ],
      currentModelId: 'default',
    };
    const providerRegistry = new ProviderRegistry();
    const manager = new ModelManager(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      providerRegistry,
    );
    const [model] = config.models;
    expect(model).toBeDefined();
    if (!model) {
      throw new Error('Expected a model config');
    }

    await manager.applyModelConfig(model, 'init');

    expect(mockCreateModelServiceAsync.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        providerId: 'gateway-primary',
        maxOutputTokens: 4096,
        requestTimeoutMs: 120_000,
        streamIdleTimeoutMs: 30_000,
      }),
    );
    expect(mockCreateModelServiceAsync.mock.calls.at(-1)?.[2]).toBe(providerRegistry);
  });

  it('should update the active model name for subsequent turns', async () => {
    const config: BladeConfig = {
      models: [createModelConfig()],
      currentModelId: 'default',
    };
    const manager = new ModelManager(config);
    const [model] = config.models;
    expect(model).toBeDefined();
    if (!model) {
      throw new Error('Expected a model config');
    }

    await manager.applyModelConfig(model, 'init');
    await manager.setModel('gpt-4.1');

    expect(manager.getModelService().getConfig().model).toBe('gpt-4.1');
    expect(config.models[0]?.model).toBe('gpt-4.1');
  });

  it('resolves vision for the active model and passes it to the service config', async () => {
    const config: BladeConfig = {
      models: [
        createModelConfig({
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          maxOutputTokens: 8000,
        }),
      ],
      currentModelId: 'default',
    };
    const manager = new ModelManager(config);
    const [model] = config.models;
    if (!model) throw new Error('Expected a model config');

    await manager.applyModelConfig(model, 'init');

    expect(manager.getVision()).toMatchObject({
      images: true,
      toolResultImages: true,
      imageTokens: 'anthropic',
    });
    expect(mockCreateModelServiceAsync.mock.calls.at(-1)?.[0].vision).toEqual(manager.getVision());
    expect(manager.getInputWindowTokens()).toBe(128000 - 8000);
  });

  it('applies the session override and remembers a runtime downgrade per model', async () => {
    const config: BladeConfig = { models: [createModelConfig()], currentModelId: 'default' };
    const manager = new ModelManager(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      ({ model }) => (model === 'gpt-4o-mini' ? { maxImagesPerRequest: 2 } : undefined),
    );
    const [model] = config.models;
    if (!model) throw new Error('Expected a model config');

    await manager.applyModelConfig(model, 'init');
    expect(manager.getVision()).toMatchObject({ images: true, maxImagesPerRequest: 2 });

    manager.markImagesUnsupported();
    expect(manager.getVision()?.images).toBe(false);

    await manager.setModel('gpt-4.1');
    expect(manager.getVision()?.images).toBe(true);

    await manager.setModel('gpt-4o-mini');
    expect(manager.getVision()?.images).toBe(false);
  });

  it('reports no vision before a model is applied', () => {
    const manager = new ModelManager({ models: [createModelConfig()] });
    expect(manager.getVision()).toBeUndefined();
    expect(manager.getInputWindowTokens()).toBeUndefined();
  });

  it.each([
    'known',
    'unregistered',
  ])('preserves the complete active state after a failed %s switch', async (target) => {
    const first = createModelConfig();
    const second = createModelConfig({ id: 'known', model: 'known', maxContextTokens: 10000 });
    const config: BladeConfig = { models: [first, second], currentModelId: first.id };
    const manager = new ModelManager(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      ({ model }) => (model === 'gpt-4o-mini' ? undefined : { maxImagesPerRequest: 0 }),
    );
    await manager.applyModelConfig(first, 'init');
    const service = manager.getModelService();
    const vision = manager.getVision();
    const window = manager.getInputWindowTokens();
    await expect(manager.setModel(target)).rejects.toThrow(
      'SessionOptions.vision.maxImagesPerRequest',
    );
    expect(manager.getInputWindowTokens()).toBe(window);
    expect(manager.getVision()).toBe(vision);
    expect(manager.getModelService()).toBe(service);
    expect(manager.resolveModelConfig()).toEqual(first);
    expect(manager.resolveModelConfig().model).toBe('gpt-4o-mini');
  });
});
