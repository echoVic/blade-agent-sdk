import { afterEach, describe, expect, it } from 'bun:test';
import type { Message } from '../../services/ChatServiceInterface.js';
import { TokenCounter } from '../TokenCounter.js';

describe('TokenCounter', () => {
  afterEach(() => {
    TokenCounter.clearCache();
  });

  describe('countTokens', () => {
    it('should count tokens for simple messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello, world!' },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('should count tokens for multiple messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(10);
    });

    it('should handle empty messages', () => {
      const messages: Message[] = [];
      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBe(0);
    });

    it('should handle messages with empty content', () => {
      const messages: Message[] = [
        { role: 'user', content: '' },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle messages with name field', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', name: 'TestUser' },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle complex content (array)', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
          ] as any,
        },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location": "San Francisco"}',
              },
            },
          ],
        },
      ];

      const count = TokenCounter.countTokens(messages, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('should use fallback encoding for unknown models', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello, world!' },
      ];

      const count = TokenCounter.countTokens(messages, 'unknown-model-xyz');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('getTokenLimit', () => {
    it('should return the provided maxTokens', () => {
      expect(TokenCounter.getTokenLimit(4096)).toBe(4096);
      expect(TokenCounter.getTokenLimit(8192)).toBe(8192);
      expect(TokenCounter.getTokenLimit(128000)).toBe(128000);
    });
  });

  describe('shouldCompact', () => {
    it('should return false when under threshold', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
      ];

      const shouldCompact = TokenCounter.shouldCompact(messages, 'gpt-4', 4096);
      expect(shouldCompact).toBe(false);
    });

    it('should return true when over threshold', () => {
      const longContent = 'Hello world. '.repeat(200);
      const messages: Message[] = [
        { role: 'user', content: longContent },
      ];

      const shouldCompact = TokenCounter.shouldCompact(messages, 'gpt-4', 100, 0.5);
      expect(shouldCompact).toBe(true);
    });

    it('should respect custom threshold', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world, this is a test message.' },
      ];

      const shouldCompactHigh = TokenCounter.shouldCompact(messages, 'gpt-4', 10000, 0.9);
      expect(shouldCompactHigh).toBe(false);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens for English text', () => {
      const text = 'Hello, world! This is a test.';
      const estimate = TokenCounter.estimateTokens(text);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(text.length);
    });

    it('should estimate tokens for Chinese text', () => {
      const text = '你好，世界！这是一个测试。';
      const estimate = TokenCounter.estimateTokens(text);
      expect(estimate).toBeGreaterThan(0);
    });

    it('should handle mixed content', () => {
      const text = 'Hello 你好 World 世界';
      const estimate = TokenCounter.estimateTokens(text);
      expect(estimate).toBeGreaterThan(0);
    });

    it('should handle empty string', () => {
      const estimate = TokenCounter.estimateTokens('');
      expect(estimate).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('should clear encoding cache', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
      ];

      TokenCounter.countTokens(messages, 'gpt-4');
      TokenCounter.clearCache();
      TokenCounter.countTokens(messages, 'gpt-4');
    });
  });
});
