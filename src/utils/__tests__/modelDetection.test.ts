import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types/common.js';
import { isThinkingModel } from '../modelDetection.js';

function createModelConfig(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai',
    model: 'gpt-4',
    ...overrides,
  };
}

describe('modelDetection', () => {
  describe('isThinkingModel', () => {
    it('should detect DeepSeek R1', () => {
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-r1' }))).toBe(true);
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-chat-r1' }))).toBe(true);
    });

    it('should detect DeepSeek Reasoner', () => {
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-reasoner' }))).toBe(true);
    });

    it('should detect OpenAI o1 models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'o1-preview' }))).toBe(true);
      expect(isThinkingModel(createModelConfig({ model: 'o1-mini' }))).toBe(true);
      expect(isThinkingModel(createModelConfig({ model: 'o1' }))).toBe(true);
    });

    it('should detect Qwen QwQ models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'qwen-qwq-32b' }))).toBe(true);
    });

    it('should detect Qwen thinking models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'qwen-think-72b' }))).toBe(true);
    });

    it('should detect Kimi k1 models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'kimi-k1-preview' }))).toBe(true);
      expect(isThinkingModel(createModelConfig({ model: 'k1-32k' }))).toBe(true);
    });

    it('should detect Doubao thinking models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'doubao-pro-think' }))).toBe(true);
    });

    it('should detect Claude Opus 4', () => {
      expect(isThinkingModel(createModelConfig({ model: 'claude-opus-4' }))).toBe(true);
    });

    it('should detect GLM-4.7', () => {
      expect(isThinkingModel(createModelConfig({ model: 'glm-4.7' }))).toBe(true);
    });

    it('should return false for non-thinking models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'gpt-4' }))).toBe(false);
      expect(isThinkingModel(createModelConfig({ model: 'gpt-4-turbo' }))).toBe(false);
      expect(isThinkingModel(createModelConfig({ model: 'claude-3-sonnet' }))).toBe(false);
      expect(isThinkingModel(createModelConfig({ model: 'claude-3-haiku' }))).toBe(false);
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-chat' }))).toBe(false);
    });

    it('should respect explicit supportsThinking=true config', () => {
      expect(isThinkingModel(createModelConfig({ model: 'gpt-4', supportsThinking: true }))).toBe(true);
    });

    it('should respect explicit supportsThinking=false config even for thinking models', () => {
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-r1', supportsThinking: false }))).toBe(false);
    });

    it('should auto-detect when supportsThinking is not set', () => {
      expect(isThinkingModel(createModelConfig({ model: 'deepseek-r1' }))).toBe(true);
      expect(isThinkingModel(createModelConfig({ model: 'gpt-4-turbo' }))).toBe(false);
    });
  });
});
