import { describe, expect, it, vi } from 'vitest';
import type {
  ChatConfig,
  IChatService,
} from '../../services/ChatServiceInterface.js';
import type { BladeConfig } from '../../types/common.js';
import type { ModelMiddleware } from '../ModelMiddleware.js';

const { createChatServiceAsync } = vi.hoisted(() => ({
  createChatServiceAsync: vi.fn(),
}));

vi.mock('../../services/ChatServiceInterface.js', () => ({
  createChatServiceAsync,
}));

const { ModelManager } = await import('../../agent/ModelManager.js');

function createService(config: ChatConfig): IChatService {
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
  it('reapplies model middleware when switching provider services', async () => {
    createChatServiceAsync.mockImplementation(async (config: ChatConfig) =>
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
    const manager = new ModelManager(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      [middleware],
    );

    await manager.applyModelConfig(manager.resolveModelConfig(), 'initial');
    await expect(manager.getChatService().chat([])).resolves.toEqual({
      content: 'model-a:wrapped',
    });

    await manager.switchModelIfNeeded('second');
    await expect(manager.getChatService().chat([])).resolves.toEqual({
      content: 'model-b:wrapped',
    });
    expect(observedModels).toEqual(['model-a', 'model-b']);
  });
});
