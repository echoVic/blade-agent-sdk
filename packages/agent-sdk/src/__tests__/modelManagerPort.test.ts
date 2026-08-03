import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateChatServiceAsync } = vi.hoisted(() => ({
  mockCreateChatServiceAsync: vi.fn(async (config: Record<string, unknown>) => ({
    chat: vi.fn(async () => ({ content: 'ok' })),
    getConfig: () => config,
  })),
}));

vi.mock('../local/chatServiceFactory.js', () => ({
  createChatServiceAsync: mockCreateChatServiceAsync,
}));

import { ModelManager } from '../local/modelManager.js';
import type { BladeConfig, ModelConfig } from '../types/common.js';

/**
 * Slice #343 — ModelManager ported into @blade-ai/agent-sdk/local.
 *
 * The model lifecycle manager (config resolution, apply/switch with
 * DeepSeek defaults + thinking detection, chat service creation) was a root
 * agent-core leaf file; root src/agent/ModelManager.ts is now a re-export
 * shim.
 */

function createConfig(): BladeConfig {
  return {
    models: [
      {
        id: 'glm-5.2',
        name: 'GLM 5.2',
        model: 'glm-5.2',
        provider: 'openai-compatible',
        maxContextTokens: 128000,
        maxOutputTokens: 4096,
      },
    ],
    currentModelId: 'glm-5.2',
  };
}

describe('ModelManager (package local)', () => {
  beforeEach(() => {
    mockCreateChatServiceAsync.mockClear();
  });

  it('resolves the current model config', () => {
    const manager = new ModelManager(createConfig());
    const resolved = manager.resolveModelConfig();
    expect(resolved.id).toBe('glm-5.2');
  });

  it('applies a model config and creates a chat service', async () => {
    const manager = new ModelManager(createConfig());
    await manager.applyModelConfig(createConfig().models[0] as ModelConfig, 'init');

    expect(manager.getCurrentModelId()).toBe('glm-5.2');
    expect(mockCreateChatServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'glm-5.2', maxOutputTokens: 4096 }),
    );
  });

  it('switches models when the requested id differs', async () => {
    const config = createConfig();
    config.models.push({
      id: 'glm-4',
      name: 'GLM 4',
      model: 'glm-4',
      provider: 'openai-compatible',
    });
    const manager = new ModelManager(config);

    await manager.switchModelIfNeeded('glm-4');
    expect(manager.getCurrentModelId()).toBe('glm-4');
    expect(mockCreateChatServiceAsync).toHaveBeenCalledTimes(1);
  });
});
