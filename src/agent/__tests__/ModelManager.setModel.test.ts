import { describe, expect, it, vi } from 'vitest';
import type { ChatConfig } from '../../services/ChatServiceInterface.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import type { BladeConfig, ModelConfig } from '../../types/common.js';

const mockCreateChatServiceAsync = vi.fn(async (
  config: ChatConfig,
  _logger?: unknown,
  _providerRegistry?: ProviderRegistry,
) => ({
  chat: vi.fn(async () => ({ content: 'ok' })),
  streamChat: vi.fn(async function* () {}),
  getConfig: () => config,
  updateConfig: vi.fn(() => {}),
}));

vi.mock('../../services/ChatServiceInterface.js', () => ({
  createChatServiceAsync: mockCreateChatServiceAsync,
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

    expect(mockCreateChatServiceAsync.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        providerId: 'gateway-primary',
        maxOutputTokens: 4096,
        requestTimeoutMs: 120_000,
        streamIdleTimeoutMs: 30_000,
      }),
    );
    expect(mockCreateChatServiceAsync.mock.calls.at(-1)?.[2]).toBe(providerRegistry);
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

    expect(manager.getChatService().getConfig().model).toBe('gpt-4.1');
    expect(config.models[0]?.model).toBe('gpt-4.1');
  });
});
