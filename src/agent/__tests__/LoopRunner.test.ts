import { describe, expect, it, vi, type Mock } from 'vitest';
import { LoopRunner } from '../LoopRunner.js';
import type { ModelManager } from '../ModelManager.js';
import type { BladeConfig } from '../../types/common.js';
import type { AgentOptions, ChatContext } from '../types.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';

// ===== Mock Factories =====

type MockContextMgr = {
  saveMessage: Mock;
  saveToolUse: Mock;
  saveToolResult: Mock;
  saveCompaction: Mock;
};

type MockModelManager = ModelManager & {
  _chat: Mock;
  _contextMgr: MockContextMgr;
};

function createMockModelManager(overrides: Partial<Record<string, unknown>> = {}): MockModelManager {
  const mockContextMgr: MockContextMgr = {
    saveMessage: vi.fn(async () => 'uuid-1'),
    saveToolUse: vi.fn(async () => 'uuid-2'),
    saveToolResult: vi.fn(async () => 'uuid-3'),
    saveCompaction: vi.fn(async () => {}),
  };
  const chatMock = vi.fn(async () => ({
    content: overrides.chatContent ?? 'Hello!',
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  }));
  return {
    getChatService: () => ({
      chat: chatMock,
      streamChat: vi.fn(async function* () {}),
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 128000,
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
      }),
      updateConfig: vi.fn(() => {}),
    }),
    getContextManager: () => mockContextMgr,
    getMaxContextTokens: () => 128000,
    switchModelIfNeeded: vi.fn(async () => {}),
    _chat: chatMock,
    _contextMgr: mockContextMgr,
  } as unknown as MockModelManager;
}

function createMockPipeline(): ExecutionPipeline {
  return {
    getRegistry: () => ({
      getAll: () => [],
      getFunctionDeclarationsByMode: () => [],
      get: (name: string) => ({ kind: 'execute', name }),
    }),
    execute: vi.fn(async (toolName: string) => ({
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
    it('should complete a single-turn agent response when no tool calls are returned', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Hello!');
      expect(result.metadata?.turnsCount).toBe(1);
      expect(result.metadata?.toolCallsCount).toBe(0);
      expect(mm._chat).toHaveBeenCalledTimes(1);
    });

    it('should persist the user message through the context store facade', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      const context = createContext({ sessionId: 'sess-1' });
      await runner.runLoop('Test message', context);

      expect(mm._contextMgr.saveMessage).toHaveBeenCalled();
    });

    it('should return error when maxTurns is 0', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const config = { ...baseConfig, maxTurns: 0 } as unknown as BladeConfig;
      const runner = new LoopRunner(config, baseOptions, mm, pipeline);

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
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      const context = createContext();
      const result = await runner.runLoop('Hello', context, { signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
    });

    it('should update context.messages after loop', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      const context = createContext({ messages: [] });
      await runner.runLoop('Hello', context);

      expect(context.messages.length).toBeGreaterThan(0);
      expect(context.messages.every(m => m.role !== 'system')).toBe(true);
    });

    it('omits environment context when requested by the chat context', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(
        baseConfig,
        { systemPrompt: 'BASE PROMPT' },
        mm,
        pipeline,
      );

      const context = createContext({ omitEnvironment: true });
      await runner.runLoop('Hello', context);

      const firstCall = mm._chat.mock.calls[0];
      const messages = firstCall?.[0] as Array<{ role: string; content: unknown }>;
      const systemMessage = messages.find((message) => message.role === 'system');
      expect(systemMessage?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'BASE PROMPT',
          }),
        ]),
      );
    });

    it('refreshes available tools on the next turn after Skill activation', async () => {
      const chatCalls: Array<unknown[] | undefined> = [];
      const chatFn = vi.fn(async (_messages, tools) => {
        chatCalls.push(tools);
        if (chatCalls.length === 1) {
          return {
            content: 'Activating skill',
            toolCalls: [{
              id: 'skill-call',
              type: 'function' as const,
              function: { name: 'Skill', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }
        return {
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
            return await chatFn(...args);
          }),
          streamChat: vi.fn(async function* () {}),
          getConfig: () => ({
            model: 'test-model',
            maxContextTokens: 128000,
            apiKey: 'test-key',
            baseUrl: 'https://test.com',
          }),
          updateConfig: vi.fn(() => {}),
        }),
        getContextManager: () => ({
          saveMessage: vi.fn(async () => 'uuid-1'),
          saveToolUse: vi.fn(async () => 'uuid-2'),
          saveToolResult: vi.fn(async () => 'uuid-3'),
          saveCompaction: vi.fn(async () => {}),
        }),
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async () => {}),
      } as unknown as MockModelManager;

      const pipeline = {
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Read', description: 'Read files', parameters: {} },
            { name: 'Write', description: 'Write files', parameters: {} },
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async (toolName: string) => {
          if (toolName === 'Skill') {
            return {
              success: true,
              llmContent: 'Skill activated',
              displayContent: 'Skill activated',
              metadata: {
                skillName: 'reader',
                basePath: '/tmp/reader',
                runtimeEffects: {
                  allowedTools: ['Read'],
                },
              },
            };
          }
          return {
            success: true,
            llmContent: `Result of ${toolName}`,
            displayContent: `Result of ${toolName}`,
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(true);
      expect(runner.skillContext).toEqual({
        skillName: 'reader',
        allowedTools: ['Read'],
        basePath: '/tmp/reader',
      });
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(chatCalls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Read' }),
        expect.objectContaining({ name: 'Write' }),
        expect.objectContaining({ name: 'Skill' }),
      ]));
      expect(chatCalls[1]).toEqual([
        expect.objectContaining({ name: 'Read' }),
      ]);
    });

    it('refreshes the chat service on the next turn after model switch', async () => {
      const firstChat = vi.fn(async () => ({
        content: 'Switching model',
        toolCalls: [{
          id: 'model-call',
          type: 'function' as const,
          function: { name: 'ModelSwitch', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }));
      const secondChat = vi.fn(async () => ({
        content: 'Now on the new model',
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }));

      let currentChatService = {
        chat: firstChat,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof firstChat>) {
          return await firstChat(...args);
        }),
        streamChat: vi.fn(async function* () {}),
        getConfig: () => ({
          model: 'model-a',
          maxContextTokens: 128000,
          apiKey: 'test-key',
          baseUrl: 'https://test.com',
        }),
        updateConfig: vi.fn(() => {}),
      };

      const mm = {
        getChatService: () => currentChatService,
        getContextManager: () => ({
          saveMessage: vi.fn(async () => 'uuid-1'),
          saveToolUse: vi.fn(async () => 'uuid-2'),
          saveToolResult: vi.fn(async () => 'uuid-3'),
          saveCompaction: vi.fn(async () => {}),
        }),
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async (modelId: string) => {
          if (modelId === 'model-b') {
            currentChatService = {
              chat: secondChat,
              chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof secondChat>) {
                return await secondChat(...args);
              }),
              streamChat: vi.fn(async function* () {}),
              getConfig: () => ({
                model: 'model-b',
                maxContextTokens: 256000,
                apiKey: 'test-key',
                baseUrl: 'https://test.com',
              }),
              updateConfig: vi.fn(() => {}),
            };
          }
        }),
      } as unknown as MockModelManager;

      const pipeline = {
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'ModelSwitch', description: 'Switch model', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Model switched',
          displayContent: 'Model switched',
          metadata: { modelId: 'model-b' },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(true);
      expect(firstChat).toHaveBeenCalledTimes(1);
      expect(secondChat).toHaveBeenCalledTimes(1);
    });
  });

  describe('skill context', () => {
    it('should start with no skill context', () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      expect(runner.skillContext).toBeUndefined();
    });

    it('should set and clear skill context', () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

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
      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);

      const prompt = await runner.buildSystemPromptOnDemand();
      expect(typeof prompt).toBe('string');
    });

    it('should compose the runtime base prompt and appended prompt', async () => {
      const mm = createMockModelManager();
      const pipeline = createMockPipeline();
      const runner = new LoopRunner(
        baseConfig,
        {
          systemPrompt: 'BASE PROMPT',
          appendSystemPrompt: 'APPEND PROMPT',
        },
        mm,
        pipeline,
      );

      const prompt = await runner.buildSystemPromptOnDemand();

      expect(prompt).toBe('BASE PROMPT\n\n---\n\nAPPEND PROMPT');
    });
  });
});
