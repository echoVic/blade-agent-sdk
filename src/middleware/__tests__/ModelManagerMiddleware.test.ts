import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BladeConfig } from '../../agent/config.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelService } from '../../model/service.js';
import type { ModelMiddleware } from '../ModelMiddleware.js';

const { createModelService } = vi.hoisted(() => ({
  createModelService: vi.fn(),
}));

vi.mock('../../services/createModelService.js', () => ({
  createModelService,
}));

const { ModelManager } = await import('../../agent/ModelManager.js');

function createService(config: ModelServiceConfig): ModelService {
  let currentConfig = config;
  return {
    async chat() {
      return { content: currentConfig.model };
    },
    async sideQuery() {
      return { content: currentConfig.model };
    },
    async *streamChat() {
      yield { content: currentConfig.model };
    },
    getConfig() {
      return currentConfig;
    },
    updateConfig(next) {
      currentConfig = { ...currentConfig, ...next };
    },
  };
}

describe('ModelManager middleware integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reapplies model middleware when switching provider services', async () => {
    createModelService.mockImplementation(async (config: ModelServiceConfig) =>
      createService(config),
    );
    const observedModels: string[] = [];
    const middleware: ModelMiddleware = {
      async wrapChat(request, next) {
        observedModels.push(request.model);
        const response = await next();
        return { ...response, content: `${response.content}:wrapped` };
      },
    };
    const config: BladeConfig = {
      currentModelId: 'first',
      models: [
        {
          id: 'first',
          name: 'First',
          provider: 'openai-compatible',
          model: 'model-a',
          apiKey: 'test',
          baseUrl: 'https://example.test',
        },
        {
          id: 'second',
          name: 'Second',
          provider: 'openai-compatible',
          model: 'model-b',
          apiKey: 'test',
          baseUrl: 'https://example.test',
        },
      ],
    };
    const manager = new ModelManager(config, undefined, undefined, undefined, undefined, [
      middleware,
    ]);

    await manager.applyModelConfig(manager.resolveModelConfig(), 'initial');
    await expect(manager.getModelService().chat([])).resolves.toEqual({
      content: 'model-a:wrapped',
    });

    await manager.switchModelIfNeeded('second');
    await expect(manager.getModelService().chat([])).resolves.toEqual({
      content: 'model-b:wrapped',
    });
    expect(observedModels).toEqual(['model-a', 'model-b']);
  });

  it('applies request timeouts outside model middleware', async () => {
    vi.useFakeTimers();
    createModelService.mockImplementation(async (config: ModelServiceConfig) =>
      createService(config),
    );
    const config: BladeConfig = {
      currentModelId: 'default',
      models: [
        {
          id: 'default',
          name: 'Default',
          provider: 'openai-compatible',
          model: 'model-a',
          apiKey: 'test',
          baseUrl: 'https://example.test',
          requestTimeoutMs: 25,
        },
      ],
    };
    const manager = new ModelManager(config, undefined, undefined, undefined, undefined, [
      {
        async wrapChat() {
          return await new Promise<never>(() => {});
        },
      },
    ]);
    await manager.applyModelConfig(manager.resolveModelConfig(), 'initial');
    const result = manager.getModelService().chat([]);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });
});
