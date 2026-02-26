import { describe, expect, it, mock } from 'bun:test';
import { LoopRunner } from '../LoopRunner.js';
import type { ModelManager } from '../ModelManager.js';
import type { BladeConfig } from '../../types/common.js';
import type { AgentOptions, ChatContext, LoopResult } from '../types.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';

// ===== Mock Factories =====

function createMockModelManager(overrides: Partial<Record<string, unknown>> = {}) {
  const mockContextMgr = {
    saveMessage: mock(async () => 'uuid-1'),
    saveToolUse: mock(async () => 'uuid-2'),
    saveToolResult: mock(async () => 'uuid-3'),
    saveCompaction: mock(async () => {}),
  };
  const mockExecutionEngine = {
    getContextManager: () => mockContextMgr,
  };
  return {
    getChatService: () => ({
      chat: mock(async () => ({
        content: overrides.chatContent ?? 'Hello!',
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      })),
      streamChat: mock(async function* () {}),
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 128000,
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
      }),
      updateConfig: mock(() => {}),
    }),
    getExecutionEngine: () => mockExecutionEngine,
    getMaxContextTokens: () => 128000,
    switchModelIfNeeded: mock(async () => {}),
    _contextMgr: mockContextMgr,
  } as unknown as ModelManager & { _contextMgr: typeof mockContextMgr };
}

function createMockPipeline() {
  return {
    getRegistry: () => ({
      getAll: () => [],
      getFunctionDeclarationsByMode: () => [],
      get: (name: string) => ({ kind: 'execute', name }),
    }),
    execute: mock(async (toolName: string) => ({
      success: true,
      llmContent: `Result of ${toolName}`,
      displayContent: `Result of ${toolName}`,
    })),
  } as unknown as ExecutionPipeline;
}

function createContext(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    messages: [],
    userId: 'test-user',
    sessionId: 'test-session',
    workspaceRoot: '/tmp/test',
    ...overrides,
  };
}

const baseConfig: BladeConfig = {
  models: [],
  maxTurns: 10,
} as unknown as BladeConfig;

const baseOptions: AgentOptions = {};

// ===== Tests =====

describe('LoopRunner', () => {
  describe('runLoop', () => {
    it('should complete a simple chat without tools', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Hello!');
      expect(result.metadata?.turnsCount).toBe(1);
      expect(result.metadata?.toolCallsCount).toBe(0);
    });

    it('should save user message to JSONL', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      const context = createContext({ sessionId: 'sess-1' });
      await runner.runLoop('Test message', context);

      expect(mm._contextMgr.saveMessage).toHaveBeenCalled();
    });

    it('should return error when maxTurns is 0', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const config = { ...baseConfig, maxTurns: 0 } as unknown as BladeConfig;
      const runner = new LoopRunner(config, baseOptions, mm as any, pipeline);

      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('chat_disabled');
    });

    it('should handle abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      const context = createContext();
      const result = await runner.runLoop('Hello', context, { signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
    });

    it('should update context.messages after loop', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      const context = createContext({ messages: [] });
      await runner.runLoop('Hello', context);

      // context.messages should be updated (system messages filtered out)
      expect(context.messages.length).toBeGreaterThan(0);
      expect(context.messages.every(m => m.role !== 'system')).toBe(true);
    });
  });

  describe('skill context', () => {
    it('should start with no skill context', () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      expect(runner.skillContext).toBeUndefined();
    });

    it('should set and clear skill context', () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      runner.setSkillContext({
        skillName: 'test-skill',
        allowedTools: ['Read', 'Write'],
        basePath: '/tmp',
      });
      expect(runner.skillContext?.skillName).toBe('test-skill');

      runner.clearSkillContext();
      expect(runner.skillContext).toBeUndefined();
    });
  });

  describe('buildSystemPromptOnDemand', () => {
    it('should return a non-empty prompt', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm as any, pipeline);

      const prompt = await runner.buildSystemPromptOnDemand();
      expect(typeof prompt).toBe('string');
    });
  });
});
