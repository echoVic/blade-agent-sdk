import { describe, expect, it } from 'bun:test';
import { detectThinkingSupport, getThinkingConfig, isThinkingModel } from '../modelDetection.js';

describe('modelDetection', () => {
  describe('detectThinkingSupport', () => {
    it('should detect DeepSeek R1', () => {
      expect(detectThinkingSupport('deepseek-r1')).toBe(true);
      expect(detectThinkingSupport('deepseek-chat-r1')).toBe(true);
    });

    it('should detect DeepSeek Reasoner', () => {
      expect(detectThinkingSupport('deepseek-reasoner')).toBe(true);
    });

    it('should detect OpenAI o1 models', () => {
      expect(detectThinkingSupport('o1-preview')).toBe(true);
      expect(detectThinkingSupport('o1-mini')).toBe(true);
      expect(detectThinkingSupport('o1')).toBe(true);
    });

    it('should detect Qwen QwQ models', () => {
      expect(detectThinkingSupport('qwen-qwq-32b')).toBe(true);
    });

    it('should detect Qwen thinking models', () => {
      expect(detectThinkingSupport('qwen-think-72b')).toBe(true);
    });

    it('should detect Kimi k1 models', () => {
      expect(detectThinkingSupport('kimi-k1-preview')).toBe(true);
      expect(detectThinkingSupport('k1-32k')).toBe(true);
    });

    it('should detect Doubao thinking models', () => {
      expect(detectThinkingSupport('doubao-pro-think')).toBe(true);
    });

    it('should detect Claude Opus 4', () => {
      expect(detectThinkingSupport('claude-opus-4')).toBe(true);
    });

    it('should detect GLM-4.7', () => {
      expect(detectThinkingSupport('glm-4.7')).toBe(true);
    });

    it('should return false for non-thinking models', () => {
      expect(detectThinkingSupport('gpt-4')).toBe(false);
      expect(detectThinkingSupport('gpt-4-turbo')).toBe(false);
      expect(detectThinkingSupport('claude-3-sonnet')).toBe(false);
      expect(detectThinkingSupport('claude-3-haiku')).toBe(false);
      expect(detectThinkingSupport('deepseek-chat')).toBe(false);
    });
  });

  describe('getThinkingConfig', () => {
    it('should use explicit user config when supportsThinking is set', () => {
      const config = getThinkingConfig({
        model: 'gpt-4',
        supportsThinking: true,
        thinkingBudget: 5000,
      } as any);
      expect(config.supportsThinking).toBe(true);
      expect(config.thinkingBudget).toBe(5000);
    });

    it('should use explicit false config', () => {
      const config = getThinkingConfig({
        model: 'deepseek-r1',
        supportsThinking: false,
      } as any);
      expect(config.supportsThinking).toBe(false);
    });

    it('should auto-detect thinking support when not explicitly set', () => {
      const config = getThinkingConfig({
        model: 'deepseek-r1',
      } as any);
      expect(config.supportsThinking).toBe(true);
      expect(config.thinkingBudget).toBeUndefined();
    });

    it('should auto-detect non-thinking model', () => {
      const config = getThinkingConfig({
        model: 'gpt-4-turbo',
      } as any);
      expect(config.supportsThinking).toBe(false);
    });
  });

  describe('isThinkingModel', () => {
    it('should return true for thinking models', () => {
      expect(isThinkingModel({ model: 'deepseek-r1' } as any)).toBe(true);
      expect(isThinkingModel({ model: 'o1-preview' } as any)).toBe(true);
    });

    it('should return false for non-thinking models', () => {
      expect(isThinkingModel({ model: 'gpt-4' } as any)).toBe(false);
      expect(isThinkingModel({ model: 'claude-3-sonnet' } as any)).toBe(false);
    });

    it('should respect explicit config', () => {
      expect(isThinkingModel({ model: 'gpt-4', supportsThinking: true } as any)).toBe(true);
    });
  });
});
