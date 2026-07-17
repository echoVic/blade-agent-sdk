import { describe, expect, it } from 'vitest';
import { resolveSessionModelConfig, createSessionKernelModel } from '../local/index.js';
import type { BladeConfig, ModelConfig } from '@blade-ai/agent-sdk';

const baseModel: ModelConfig = {
  id: 'test-model',
  model: 'gpt-4',
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.test.com',
};

const baseConfig: BladeConfig = {
  models: [baseModel],
  currentModelId: 'test-model',
};

describe('resolveSessionModelConfig', () => {
  it('returns model by currentModelId', () => {
    const cfg = resolveSessionModelConfig(baseConfig);
    expect(cfg.id).toBe('test-model');
  });

  it('returns requested model by id', () => {
    const cfg = resolveSessionModelConfig(
      { ...baseConfig, models: [baseModel, { ...baseModel, id: 'other' }] },
      'other',
    );
    expect(cfg.id).toBe('other');
  });

  it('falls back to first model if currentModelId not found', () => {
    const cfg = resolveSessionModelConfig({
      models: [baseModel],
      currentModelId: 'unknown',
    });
    expect(cfg.id).toBe('test-model');
  });

  it('throws when no model config found', () => {
    expect(() => resolveSessionModelConfig({ models: [] })).toThrow('模型配置未找到');
  });
});

describe('createSessionKernelModel', () => {
  it('creates a kernel model from config', () => {
    const result = createSessionKernelModel(baseConfig);
    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.modelRequestDefaults).toBeDefined();
    expect(result.modelRequestDefaults.model).toBe('gpt-4');
    expect(result.modelConfig).toBeDefined();
  });
});
