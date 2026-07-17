import { describe, expect, it } from 'vitest';
import {
  ContextCompressor,
  ContextFilterProcessor,
  SessionId,
} from '../local/index.js';
import type { ContextData, ContextMessage } from '../local/index.js';

/** Minimal factory for a well-shaped ContextData to test processors. */
function makeContextData(
  messages: ContextMessage[],
  toolCalls: ContextData['layers']['tool']['recentCalls'] = [],
): ContextData {
  return {
    layers: {
      system: { role: 'assistant', capabilities: [], tools: [], version: '1.0' },
      session: { sessionId: 's1' as SessionId, preferences: {}, configuration: {}, startTime: Date.now() },
      conversation: { messages, topics: [], lastActivity: Date.now() },
      tool: { recentCalls: toolCalls, toolStates: {}, dependencies: {} },
      workspace: { currentFiles: [], recentFiles: [], environment: {} },
    },
    metadata: { totalTokens: 0, priority: 1, lastUpdated: Date.now() },
  };
}

describe('ContextCompressor', () => {
  it('creates an instance with default options', () => {
    const compressor = new ContextCompressor();
    expect(compressor).toBeDefined();
  });

  it('creates an instance with custom limits', () => {
    const compressor = new ContextCompressor(200, 5, 10);
    expect(compressor).toBeDefined();
  });

  it('shouldCompress returns false for small context', () => {
    const compressor = new ContextCompressor();
    const contextData = makeContextData([
      { id: 'm1', role: 'user' as const, content: 'hello', timestamp: Date.now() },
    ]);
    expect(compressor.shouldCompress(contextData, 100)).toBe(false);
  });

  it('shouldCompress returns true when exceeding 80% of max', () => {
    const compressor = new ContextCompressor();
    // 1000 chars ≈ 250 tokens (1000/4), maxTokens=100 → 80% threshold = 80
    const bigContent = 'a'.repeat(1000);
    const contextData = makeContextData([
      { id: 'mb1', role: 'user' as const, content: bigContent, timestamp: Date.now() },
      { id: 'mb2', role: 'assistant' as const, content: bigContent, timestamp: Date.now() },
    ]);
    expect(compressor.shouldCompress(contextData, 100)).toBe(true);
  });

  it('compress produces summary and keyPoints', async () => {
    const compressor = new ContextCompressor();
    const contextData = makeContextData([
      { id: 'm0', role: 'system' as const, content: 'you are helpful', timestamp: Date.now() },
      { id: 'mu1', role: 'user' as const, content: '关于项目，需要创建一个功能。请帮我实现。', timestamp: Date.now() },
      { id: 'ma1', role: 'assistant' as const, content: '好的，决定采用模块化设计。', timestamp: Date.now() },
    ]);
    const result = await compressor.compress(contextData);
    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.recentMessages)).toBe(true);
    expect(result.recentMessages.some((m) => m.role === 'system')).toBe(true);
  });

  it('preserves recent messages while compressing older ones', async () => {
    const compressor = new ContextCompressor(500, 10, 2);
    const messages = [
      { id: 'mo1', role: 'user' as const, content: 'old message 1', timestamp: Date.now() - 9999 },
      { id: 'mo2', role: 'assistant' as const, content: 'old response 1', timestamp: Date.now() - 9998 },
      { id: 'mr1', role: 'user' as const, content: 'recent message 1', timestamp: Date.now() - 1 },
      { id: 'mr2', role: 'assistant' as const, content: 'recent response 1', timestamp: Date.now() },
    ];
    const contextData = makeContextData(messages);
    const result = await compressor.compress(contextData);
    // Recent messages limit=2, so last 2 conversation messages preserved
    expect(result.recentMessages.length).toBeLessThan(messages.length);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('handles empty messages gracefully', async () => {
    const compressor = new ContextCompressor();
    const contextData = makeContextData([]);
    const result = await compressor.compress(contextData);
    expect(result.summary).toBe('');
    expect(result.keyPoints).toEqual([]);
  });
});

describe('ContextFilterProcessor', () => {
  it('creates an instance with default options', () => {
    const filter = new ContextFilterProcessor();
    expect(filter).toBeDefined();
  });

  it('creates an instance with custom options', () => {
    const filter = new ContextFilterProcessor({
      maxTokens: 1000,
      maxMessages: 10,
      timeWindow: 60 * 60 * 1000,
    });
    expect(filter).toBeDefined();
  });

  it('filter returns context unchanged when under limits', () => {
    const filter = new ContextFilterProcessor();
    const shortContent = 'short message';
    const contextData = makeContextData([
      { id: 'ms1', role: 'user' as const, content: shortContent, timestamp: Date.now() },
    ]);
    const result = filter.filter(contextData);
    expect(result.layers.conversation.messages).toHaveLength(1);
  });

  it('filter respects maxMessages limit', () => {
    const filter = new ContextFilterProcessor({ maxMessages: 2 });
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `arr${i}`,
      role: 'user' as const,
      content: `message ${i}`,
      timestamp: Date.now() - (10 - i) * 1000,
    }));
    const contextData = makeContextData(messages);
    const result = filter.filter(contextData);
    expect(result.layers.conversation.messages.length).toBeLessThanOrEqual(2);
  });

  it('filter respects timeWindow', () => {
    const filter = new ContextFilterProcessor({ timeWindow: 30 * 60 * 1000 }); // 30min
    const messages = [
      { id: 'tw1', role: 'user' as const, content: 'old message', timestamp: Date.now() - 3600_000 }, // 1h ago
      { id: 'tw2', role: 'user' as const, content: 'recent message', timestamp: Date.now() - 1000 }, // 1s ago
    ];
    const contextData = makeContextData(messages);
    const result = filter.filter(contextData);
    expect(result.layers.conversation.messages.length).toBeLessThanOrEqual(1);
  });
});
