import { describe, expect, it, vi, type Mock } from 'vitest';
import { LoopRunner } from '../LoopRunner.js';
import type { ModelManager } from '../ModelManager.js';
import type { BladeConfig } from '../../types/common.js';
import type { AgentOptions, ChatContext } from '../types.js';
import * as FileAnalyzerModule from '../../context/FileAnalyzer.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { HookRuntime } from '../../hooks/HookRuntime.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';

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

function createRetryEventsMock<TArgs extends unknown[], TResult>(
  chatFn: (...args: TArgs) => Promise<TResult>,
) {
  return vi.fn(async function* (...args: TArgs): AsyncGenerator<never, TResult, unknown> {
    return await chatFn(...args);
  });
}

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
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
              runtimePatch: {
                scope: 'session',
                source: 'skill',
                skill: {
                  id: 'reader',
                  name: 'reader',
                  basePath: '/tmp/reader',
                },
                toolPolicy: {
                  allow: ['Read'],
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
      expect(runner.skillContext).toEqual(expect.objectContaining({
        skillId: 'reader',
        skillName: 'reader',
        allowedTools: ['Read'],
        basePath: '/tmp/reader',
      }));
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

    it('caches skill activation analysis until the message list changes', async () => {
      const analyzeFilesSpy = vi.spyOn(FileAnalyzerModule, 'analyzeFiles');
      const chatFn = vi.fn(async (_messages, tools) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('Skill')) {
          return {
            content: 'Activate skill',
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
      })
        .mockResolvedValueOnce({
          content: 'Activate skill',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Skill activated',
          displayContent: 'Skill activated',
          runtimePatch: {
            scope: 'session',
            source: 'skill',
            skill: {
              id: 'reader',
              name: 'reader',
              basePath: '/tmp/reader',
            },
            toolPolicy: {
              allow: ['Read'],
            },
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext({
        systemPrompt: 'BASE PROMPT',
      }));

      expect(result.success).toBe(true);
      expect(analyzeFilesSpy).toHaveBeenCalledTimes(2);
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
        chatWithRetryEvents: createRetryEventsMock(firstChat),
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
              chatWithRetryEvents: createRetryEventsMock(secondChat),
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
          runtimePatch: {
            scope: 'session',
            source: 'tool',
            modelOverride: { modelId: 'model-b' },
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const context = createContext();
      const result = await runner.runLoop('Hello', context);

      expect(result.success).toBe(true);
      expect(firstChat).toHaveBeenCalledTimes(1);
      expect(secondChat).toHaveBeenCalledTimes(1);
    });

    it('does not derive runtime state from legacy metadata on non-Skill tools', async () => {
      const chatFn = vi.fn(async () => ({
        content: 'Done',
        toolCalls: [{
          id: 'legacy-call',
          type: 'function' as const,
          function: { name: 'LegacyTool', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Triggering legacy metadata',
          toolCalls: [{
            id: 'legacy-call',
            type: 'function' as const,
            function: { name: 'LegacyTool', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const switchModelIfNeeded = vi.fn(async () => {});
      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
        switchModelIfNeeded,
      } as unknown as MockModelManager;

      const pipeline = {
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'LegacyTool', description: 'Legacy tool', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Legacy result',
          displayContent: 'Legacy result',
          metadata: {
            allowedTools: ['Read'],
            modelId: 'model-b',
            skillName: 'reader',
            basePath: '/tmp/reader',
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(runner.skillContext).toBeUndefined();
      expect(switchModelIfNeeded).not.toHaveBeenCalled();
    });

    it('does not apply runtime patches from failed tool results', async () => {
      const chatFn = vi.fn(async () => ({
        content: 'Done',
        toolCalls: [{
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'Skill', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Failing skill',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const switchModelIfNeeded = vi.fn(async () => {});
      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
        switchModelIfNeeded,
      } as unknown as MockModelManager;

      const pipeline = {
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: false,
          llmContent: 'failed',
          displayContent: 'failed',
          error: {
            type: 'execution_error',
            message: 'boom',
          },
          runtimePatch: {
            scope: 'session',
            source: 'skill',
            skill: {
              id: 'reader',
              name: 'reader',
              basePath: '/tmp/reader',
            },
            toolPolicy: {
              allow: ['Read'],
            },
            modelOverride: {
              modelId: 'model-b',
            },
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(runner.skillContext).toBeUndefined();
      expect(switchModelIfNeeded).not.toHaveBeenCalled();
    });

    it('clears turn-scoped runtime patches after the loop completes', async () => {
      const chatFn = vi.fn(async (_messages, _tools) => ({
        content: 'Turn complete',
        toolCalls: [{
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'Skill', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Activating skill',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Skill activated',
          displayContent: 'Skill activated',
          runtimePatch: {
            scope: 'turn',
            source: 'skill',
            skill: {
              id: 'reader',
              name: 'reader',
              basePath: '/tmp/reader',
            },
            toolPolicy: {
              allow: ['Read'],
            },
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      await runner.runLoop('Hello', createContext());

      expect(runner.skillContext).toBeUndefined();
    });

    it('clears stale tool policy when a new skill runtime patch omits toolPolicy', async () => {
      const chatCalls: Array<Array<{ name: string }>> = [];
      const chatFn = vi.fn(async (_messages, tools = []) => {
        chatCalls.push((tools as Array<{ name: string }>).map((tool) => ({ name: tool.name })));

        if (chatCalls.length === 1) {
          return {
            content: 'Activate first skill',
            toolCalls: [{
              id: 'skill-call-1',
              type: 'function' as const,
              function: { name: 'Skill', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        if (chatCalls.length === 2) {
          return {
            content: 'Activate second skill',
            toolCalls: [{
              id: 'skill-call-2',
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
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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

      let skillExecutions = 0;
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
        execute: vi.fn(async () => {
          skillExecutions += 1;

          if (skillExecutions === 1) {
            return {
              success: true,
              llmContent: 'Skill activated',
              displayContent: 'Skill activated',
              runtimePatch: {
                scope: 'session',
                source: 'skill',
                skill: {
                  id: 'reader',
                  name: 'reader',
                  basePath: '/tmp/reader',
                },
                toolPolicy: {
                  allow: ['Read', 'Skill'],
                },
              },
            };
          }

          return {
            success: true,
            llmContent: 'Skill switched',
            displayContent: 'Skill switched',
            runtimePatch: {
              scope: 'session',
              source: 'skill',
              skill: {
                id: 'writer',
                name: 'writer',
                basePath: '/tmp/writer',
              },
            },
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(runner.skillContext).toEqual(expect.objectContaining({
        skillId: 'writer',
        skillName: 'writer',
        allowedTools: undefined,
      }));
      expect(chatCalls[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Read' }),
        expect.objectContaining({ name: 'Write' }),
        expect.objectContaining({ name: 'Skill' }),
      ]));
      expect(chatCalls[1]).toEqual([
        expect.objectContaining({ name: 'Read' }),
        expect.objectContaining({ name: 'Skill' }),
      ]);
      expect(chatCalls[2]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Read' }),
        expect.objectContaining({ name: 'Write' }),
        expect.objectContaining({ name: 'Skill' }),
      ]));
    });

    it('registers session-scoped runtime hooks from skill runtime patches', async () => {
      const chatFn = vi.fn(async () => ({
        content: 'Done',
        toolCalls: [{
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'Skill', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Activate skill hooks',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Skill activated',
          displayContent: 'Skill activated',
          runtimePatch: {
            scope: 'session',
            source: 'skill',
            skill: {
              id: 'reviewer',
              name: 'reviewer',
              basePath: '/tmp/reviewer',
            },
            hooks: [{
              event: HookEvent.UserPromptSubmit,
              type: 'append_prompt',
              value: 'Always include concrete file paths.',
            }],
          } as any,
        })),
      } as unknown as ExecutionPipeline;

      const hookRuntime = new HookRuntime({
        sessionId: 'test-session',
        permissionMode: PermissionMode.DEFAULT,
        resolveProjectDir: () => undefined,
        hookManager: {
          executeUserPromptSubmitHooks: vi.fn(async () => ({ proceed: true })),
        } as never,
      });

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline, undefined, undefined, undefined, undefined, undefined, hookRuntime);
      await runner.runLoop('Hello', createContext());

      const rewritten = await hookRuntime.applyUserPromptSubmit('Original prompt');
      expect(rewritten).toBe('Original prompt\n\nAlways include concrete file paths.');
    });

    it('clears turn-scoped runtime hooks after the loop completes', async () => {
      const chatFn = vi.fn(async () => ({
        content: 'Done',
        toolCalls: [{
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'Skill', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Activate turn hook',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Skill activated',
          displayContent: 'Skill activated',
          runtimePatch: {
            scope: 'turn',
            source: 'skill',
            skill: {
              id: 'reviewer',
              name: 'reviewer',
              basePath: '/tmp/reviewer',
            },
            hooks: [{
              event: HookEvent.UserPromptSubmit,
              type: 'append_prompt',
              value: 'Turn-scoped hint.',
            }],
          } as any,
        })),
      } as unknown as ExecutionPipeline;

      const hookRuntime = new HookRuntime({
        sessionId: 'test-session',
        permissionMode: PermissionMode.DEFAULT,
        resolveProjectDir: () => undefined,
        hookManager: {
          executeUserPromptSubmitHooks: vi.fn(async () => ({ proceed: true })),
        } as never,
      });

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline, undefined, undefined, undefined, undefined, undefined, hookRuntime);
      await runner.runLoop('Hello', createContext());

      const rewritten = await hookRuntime.applyUserPromptSubmit('Original prompt');
      expect(rewritten).toBe('Original prompt');
    });

    it('applies session-scoped runtime system prompt append to subsequent prompt construction', async () => {
      const chatFn = vi.fn(async () => ({
        content: 'Done',
        toolCalls: [{
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'Skill', arguments: '{}' },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }))
        .mockResolvedValueOnce({
          content: 'Activate prompt overlay',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async () => ({
          success: true,
          llmContent: 'Skill activated',
          displayContent: 'Skill activated',
          runtimePatch: {
            scope: 'session',
            source: 'skill',
            skill: {
              id: 'reviewer',
              name: 'reviewer',
              basePath: '/tmp/reviewer',
            },
            systemPromptAppend: 'RUNTIME APPEND',
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(
        baseConfig,
        {
          systemPrompt: 'BASE PROMPT',
          appendSystemPrompt: 'STATIC APPEND',
        },
        mm,
        pipeline,
      );

      await runner.runLoop('Hello', createContext());

      const prompt = await runner.buildSystemPromptOnDemand();
      expect(prompt).toBe('BASE PROMPT\n\n---\n\nSTATIC APPEND\n\n---\n\nRUNTIME APPEND');
    });

    it('applies runtime environment overlays to subsequent tool executions in the same loop', async () => {
      const observedEnvironments: Array<Record<string, string> | undefined> = [];
      const chatFn = vi.fn(async (_messages, tools = []) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('Skill')) {
          return {
            content: 'Activate env skill',
            toolCalls: [{
              id: 'skill-call',
              type: 'function' as const,
              function: { name: 'Skill', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        return {
          content: 'Inspect env',
          toolCalls: [{
            id: 'env-call',
            type: 'function' as const,
            function: { name: 'EnvTool', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      })
        .mockResolvedValueOnce({
          content: 'Activate env skill',
          toolCalls: [{
            id: 'skill-call',
            type: 'function' as const,
            function: { name: 'Skill', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Inspect env',
          toolCalls: [{
            id: 'env-call',
            type: 'function' as const,
            function: { name: 'EnvTool', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mm = {
        getChatService: () => ({
          chat: chatFn,
          chatWithRetryEvents: createRetryEventsMock(chatFn),
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

      let callCount = 0;
      const pipeline = {
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => {
            callCount += 1;
            if (callCount === 1) {
              return [{ name: 'Skill', description: 'Load a skill', parameters: {} }];
            }
            return [{ name: 'EnvTool', description: 'Inspect env', parameters: {} }];
          },
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: vi.fn(async (
          toolName: string,
          _params: Record<string, unknown>,
          executionContext: { contextSnapshot?: { environment?: Record<string, string> } },
        ) => {
          if (toolName === 'Skill') {
            return {
              success: true,
              llmContent: 'Skill activated',
              displayContent: 'Skill activated',
              runtimePatch: {
                scope: 'session',
                source: 'skill',
                skill: {
                  id: 'env-skill',
                  name: 'env-skill',
                  basePath: '/tmp/env-skill',
                },
                environment: {
                  SKILL_MODE: 'enabled',
                },
              },
            };
          }

          observedEnvironments.push(executionContext.contextSnapshot?.environment);
          return {
            success: true,
            llmContent: 'Environment inspected',
            displayContent: 'Environment inspected',
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(observedEnvironments).toEqual([
        expect.objectContaining({
          SKILL_MODE: 'enabled',
        }),
      ]);
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
        skillId: 'test-skill',
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
