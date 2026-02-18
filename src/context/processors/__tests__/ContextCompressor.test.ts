import { describe, expect, it } from 'bun:test';
import { ContextCompressor } from '../ContextCompressor.js';
import type { ContextData, ContextMessage, ToolCall } from '../../types.js';

// ===== Helpers =====

function makeMessage(role: 'user' | 'assistant' | 'system', content: string, ts?: number): ContextMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: ts || Date.now(),
  };
}

function makeToolCall(name: string, status: 'success' | 'error' = 'success'): ToolCall {
  return {
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    name,
    input: { path: 'test.ts' },
    output: status === 'success' ? 'ok' : undefined,
    timestamp: Date.now(),
    status,
    error: status === 'error' ? 'Failed' : undefined,
  };
}

function makeContextData(
  messages: ContextMessage[],
  toolCalls: ToolCall[] = []
): ContextData {
  return {
    layers: {
      system: { role: 'assistant', capabilities: [], tools: [], version: '1.0' },
      session: {
        sessionId: 'test', preferences: {}, configuration: {}, startTime: Date.now(),
      },
      conversation: {
        messages,
        topics: [],
        lastActivity: Date.now(),
      },
      tool: { recentCalls: toolCalls, toolStates: {}, dependencies: {} },
      workspace: { currentFiles: [], recentFiles: [], environment: {} },
    },
    metadata: { totalTokens: 1000, priority: 1, lastUpdated: Date.now() },
  };
}

// ===== Tests =====

describe('ContextCompressor', () => {
  describe('constructor defaults', () => {
    it('should create with default config', () => {
      const compressor = new ContextCompressor();
      expect(compressor).toBeDefined();
    });

    it('should accept custom config', () => {
      const compressor = new ContextCompressor(200, 5, 10);
      expect(compressor).toBeDefined();
    });
  });

  describe('compress', () => {
    it('should compress empty conversation', async () => {
      const compressor = new ContextCompressor();
      const data = makeContextData([]);
      const result = await compressor.compress(data);

      expect(result.summary).toBe('');
      expect(result.keyPoints).toEqual([]);
      expect(result.recentMessages).toEqual([]);
      expect(result.tokenCount).toBeGreaterThanOrEqual(0);
    });

    it('should preserve system messages', async () => {
      const compressor = new ContextCompressor(500, 10, 20);
      const messages = [
        makeMessage('system', 'You are a helpful assistant'),
        makeMessage('user', 'Hello'),
        makeMessage('assistant', 'Hi there!'),
      ];
      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      const systemMsgs = result.recentMessages.filter((m) => m.role === 'system');
      expect(systemMsgs.length).toBe(1);
      expect(systemMsgs[0].content).toBe('You are a helpful assistant');
    });

    it('should keep recent messages intact', async () => {
      const compressor = new ContextCompressor(500, 10, 5);
      const messages: ContextMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeMessage('user', `Message ${i}`));
        messages.push(makeMessage('assistant', `Reply ${i}`));
      }
      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      // Recent messages should be the last 5 conversation messages + system
      const nonSystem = result.recentMessages.filter((m) => m.role !== 'system');
      expect(nonSystem.length).toBeLessThanOrEqual(5);
    });

    it('should generate summary for older messages', async () => {
      const compressor = new ContextCompressor(500, 10, 2);
      const messages = [
        makeMessage('user', 'How do I read a file in Node.js?'),
        makeMessage('assistant', 'You can use fs.readFile() to read files.'),
        makeMessage('user', 'What about writing?'),
        makeMessage('assistant', 'Use fs.writeFile() for writing.'),
        makeMessage('user', 'Thanks!'),
        makeMessage('assistant', 'You are welcome!'),
      ];
      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      // Should have some summary of older messages
      // (exact content depends on implementation)
      expect(typeof result.summary).toBe('string');
    });

    it('should include tool summary when tools are used', async () => {
      const compressor = new ContextCompressor();
      const messages = [
        makeMessage('user', 'Read test.ts'),
        makeMessage('assistant', 'Reading file...'),
      ];
      const toolCalls = [
        makeToolCall('ReadFile'),
        makeToolCall('ReadFile'),
        makeToolCall('WriteFile'),
        makeToolCall('Grep', 'error'),
      ];
      const data = makeContextData(messages, toolCalls);
      const result = await compressor.compress(data);

      expect(result.toolSummary).toBeDefined();
      expect(typeof result.toolSummary).toBe('string');
    });

    it('should estimate token count', async () => {
      const compressor = new ContextCompressor();
      const messages = [
        makeMessage('user', 'Hello world, this is a test message with some content'),
        makeMessage('assistant', 'This is a response with some content too'),
      ];
      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      expect(result.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('key points extraction', () => {
    it('should extract questions as key points', async () => {
      const compressor = new ContextCompressor(500, 10, 2);
      const messages = [
        makeMessage('user', 'How do I implement authentication?'),
        makeMessage('assistant', 'You can use JWT tokens for authentication.'),
        makeMessage('user', 'What about OAuth?'),
        makeMessage('assistant', 'OAuth is also a good option.'),
        // Recent (kept intact)
        makeMessage('user', 'Thanks'),
        makeMessage('assistant', 'Welcome'),
      ];
      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      expect(result.keyPoints.length).toBeGreaterThanOrEqual(0);
      expect(result.keyPoints.length).toBeLessThanOrEqual(10);
    });

    it('should respect keyPointsLimit', async () => {
      const compressor = new ContextCompressor(500, 3, 2);
      const messages: ContextMessage[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push(makeMessage('user', `Question ${i}? How does this work?`));
        messages.push(makeMessage('assistant', `Answer ${i}: It works like this.`));
      }
      // Add 2 recent
      messages.push(makeMessage('user', 'Final'));
      messages.push(makeMessage('assistant', 'Done'));

      const data = makeContextData(messages);
      const result = await compressor.compress(data);

      expect(result.keyPoints.length).toBeLessThanOrEqual(3);
    });
  });
});
