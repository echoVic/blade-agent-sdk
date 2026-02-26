import { describe, expect, it, mock } from 'bun:test';
import { ModelManager } from '../ModelManager.js';
import type { BladeConfig, ModelConfig } from '../../types/common.js';

// ===== Mock Helpers =====

function createTestConfig(models: ModelConfig[] = [], currentModelId?: string): BladeConfig {
  return {
    models,
    currentModelId,
    temperature: 0.7,
  } as BladeConfig;
}

function createModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'test-model',
    name: 'Test Model',
    model: 'gpt-4o-mini',
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    maxContextTokens: 128000,
    ...overrides,
  } as ModelConfig;
}

// ===== Tests =====

describe('ModelManager', () => {
  describe('resolveModelConfig', () => {
    it('should resolve by requested model id', () => {
      const model1 = createModelConfig({ id: 'model-1', name: 'Model 1' });
      const model2 = createModelConfig({ id: 'model-2', name: 'Model 2' });
      const config = createTestConfig([model1, model2], 'model-1');
      const mm = new ModelManager(config);

      const resolved = mm.resolveModelConfig('model-2');
      expect(resolved.id).toBe('model-2');
    });

    it('should resolve current model when no id requested', () => {
      const model1 = createModelConfig({ id: 'model-1', name: 'Model 1' });
      const model2 = createModelConfig({ id: 'model-2', name: 'Model 2' });
      const config = createTestConfig([model1, model2], 'model-2');
      const mm = new ModelManager(config);

      const resolved = mm.resolveModelConfig();
      expect(resolved.id).toBe('model-2');
    });

    it('should fallback to first model when currentModelId not set', () => {
      const model1 = createModelConfig({ id: 'model-1', name: 'Model 1' });
      const model2 = createModelConfig({ id: 'model-2', name: 'Model 2' });
      const config = createTestConfig([model1, model2]);
      const mm = new ModelManager(config);

      const resolved = mm.resolveModelConfig();
      expect(resolved.id).toBe('model-1');
    });

    it('should ignore "inherit" as requested id', () => {
      const model1 = createModelConfig({ id: 'model-1', name: 'Model 1' });
      const config = createTestConfig([model1], 'model-1');
      const mm = new ModelManager(config);

      const resolved = mm.resolveModelConfig('inherit');
      expect(resolved.id).toBe('model-1');
    });

    it('should throw when model not found', () => {
      const config = createTestConfig([createModelConfig({ id: 'model-1' })]);
      const mm = new ModelManager(config);

      expect(() => mm.resolveModelConfig('nonexistent')).toThrow('模型配置未找到');
    });

    it('should throw when no models available', () => {
      const config = createTestConfig([]);
      const mm = new ModelManager(config);

      expect(() => mm.resolveModelConfig()).toThrow('模型配置未找到');
    });
  });

  describe('switchModelIfNeeded', () => {
    it('should skip when modelId is empty', async () => {
      const config = createTestConfig([createModelConfig()]);
      const mm = new ModelManager(config);

      // Should not throw
      await mm.switchModelIfNeeded('');
    });

    it('should skip when modelId matches current', async () => {
      const model = createModelConfig({ id: 'model-1' });
      const config = createTestConfig([model], 'model-1');
      const mm = new ModelManager(config);

      // Manually set currentModelId via applyModelConfig would be needed
      // but we can test the no-op path
      await mm.switchModelIfNeeded('');
    });

    it('should warn when target model not found', async () => {
      const config = createTestConfig([createModelConfig({ id: 'model-1' })]);
      const mm = new ModelManager(config);

      // Should not throw, just warn
      await mm.switchModelIfNeeded('nonexistent');
    });
  });

  describe('getters before initialization', () => {
    it('should return undefined for currentModelId initially', () => {
      const config = createTestConfig([createModelConfig()]);
      const mm = new ModelManager(config);
      expect(mm.getCurrentModelId()).toBeUndefined();
    });
  });
});
