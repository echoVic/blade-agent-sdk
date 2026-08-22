import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import { ContextManager } from '../../context/ContextManager.js';
import * as FileAnalyzerModule from '../../context/FileAnalyzer.js';
import { HookRuntime } from '../../hooks/HookRuntime.js';
import type { RuntimeContextPatch } from '../../runtime/RuntimeContextPatch.js';
import type { RuntimePatch } from '../../runtime/RuntimePatch.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import { JsonlSessionStore } from '../../session/SessionStore.js';
import { ToolCatalog } from '../../tools/catalog/ToolCatalog.js';
import { createTool } from '../../tools/core/createTool.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import {
  completeToolExecution,
  type ToolEffect,
  type ToolResult,
} from '../../tools/types/index.js';
import { ToolKind } from '../../tools/types/ToolKind.js';
import { SessionId } from '../../types/branded.js';
import type { BladeConfig } from '../../types/common.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import { LoopRunner } from '../LoopRunner.js';
import type { ModelManager } from '../ModelManager.js';
import { ConversationState } from '../state/ConversationState.js';
import type { AgentOptions, ChatContext } from '../types.js';

// ===== Mock Factories =====

type MockContextMgr = {
  saveMessage: Mock;
  saveToolUse: Mock;
  saveToolResult: Mock;
  saveCompaction: Mock;
};

interface MockToolResult {
  status: 'success' | 'error';
  model: string | object;
  error?: { type: string; message: string };
  metadata?: ToolResult['metadata'];
  effects?: ToolEffect[];
  runtimePatch?: unknown;
  contextPatch?: unknown;
  newMessages?: Message[];
}

function mockToolExecution<TArgs extends unknown[]>(
  implementation: (...args: TArgs) => Promise<MockToolResult>,
) {
  return vi.fn(async function* (...args: TArgs) {
    const {
      effects = [],
      runtimePatch,
      contextPatch,
      newMessages,
      ...result
    } = await implementation(...args);
    for (const effect of effects) {
      yield { kind: 'effect' as const, effect };
    }
    if (runtimePatch) {
      yield {
        kind: 'effect' as const,
        effect: { type: 'runtimePatch' as const, patch: runtimePatch as RuntimePatch },
      };
    }
    if (contextPatch) {
      yield {
        kind: 'effect' as const,
        effect: { type: 'contextPatch' as const, patch: contextPatch as RuntimeContextPatch },
      };
    }
    if (newMessages) {
      yield { kind: 'effect' as const, effect: { type: 'newMessages' as const, messages: newMessages } };
    }
    return result as ToolResult;
  });
}

type MockModelManager = ModelManager & {
  _chat: Mock;
  _contextMgr: MockContextMgr;
};

function createRetryEventsMock<TArgs extends unknown[], TResult>(
  chatFn: (...args: TArgs) => Promise<TResult>,
) {
  // biome-ignore lint/correctness/useYield: generator used only for its return value
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
    getCatalog: () => undefined,
    getRegistry: () => ({
      getAll: () => [],
      getFunctionDeclarationsByMode: () => [],
      get: (name: string) => ({ kind: 'execute', name }),
    }),
    execute: mockToolExecution(async (toolName: string) => ({
      status: 'success',
      model: `Result of ${toolName}`,
    })),
  } as unknown as ExecutionPipeline;
}

function createContext(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    messages: [],
    userId: 'test-user',
    sessionId: SessionId('test-session'),
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

      const context = createContext({ sessionId: SessionId('sess-1') });
      await runner.runLoop('Test message', context);

      expect(mm._contextMgr.saveMessage).toHaveBeenCalled();
    });

    it('persists streaming tool turns in provider-compatible order', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'loop-runner-persistence-'));
      const sessionId = SessionId('streaming-tool-session');
      const contextManager = new ContextManager({
        projectPath: workspaceRoot,
        storage: {
          maxMemorySize: 1000,
          persistentPath: workspaceRoot,
          cacheSize: 100,
          compressionEnabled: true,
        },
      });
      await contextManager.initialize();
      await contextManager.createSession(undefined, {}, { sessionId });

      let turn = 0;
      const streamChat = vi.fn(async function* () {
        turn += 1;
        if (turn === 1) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: 'call-first',
                function: { name: 'Search', arguments: '{"query":"first"}' },
              },
              {
                index: 1,
                id: 'call-second',
                function: { name: 'Search', arguments: '{"query":"second"}' },
              },
            ],
          };
          yield { finishReason: 'tool_calls' };
          return;
        }
        yield { content: 'done' };
        yield { finishReason: 'stop' };
      });
      const modelManager = {
        getChatService: () => ({
          chat: vi.fn(),
          streamChat,
          getConfig: () => ({
            model: 'test-model',
            maxContextTokens: 128000,
          }),
          updateConfig: vi.fn(),
        }),
        getContextManager: () => contextManager,
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async () => {}),
      } as unknown as ModelManager;
      const pipeline = {
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Search', description: 'Search', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'readonly', name }),
        }),
        execute: mockToolExecution(async (toolName: string, params: Record<string, unknown>) => ({
          status: 'success',
          model: `${toolName}:${String(params.query)}`,
        })),
      } as unknown as ExecutionPipeline;
      const runner = new LoopRunner(
        baseConfig,
        baseOptions,
        modelManager,
        pipeline,
        workspaceRoot,
        undefined,
        true,
      );

      const result = await runner.runLoop('run both searches', createContext({ sessionId }));
      const state = await new JsonlSessionStore(workspaceRoot).loadState(sessionId);

      expect(result.success).toBe(true);
      expect(state?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ]);
      expect(state?.messages[1]?.tool_calls?.map((toolCall) => toolCall.id)).toEqual([
        'call-first',
        'call-second',
      ]);
      expect(state?.messages.slice(2, 4).map((message) => message.tool_call_id)).toEqual([
        'call-first',
        'call-second',
      ]);
      expect(new Set(state?.messageIds).size).toBe(state?.messageIds.length);
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
      // After the loop, context.messages should not contain the root system prompt
      // (it's managed by ConversationState), but may contain non-root system messages
      // with valid _systemSource (e.g., catalog, tool_injection).
      const hasRootPrompt = context.messages.some(
        m => m.role === 'system' && !(m.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata) && '_systemSource' in m.metadata)
      );
      expect(hasRootPrompt).toBe(false);
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Read', description: 'Read files', parameters: {} },
            { name: 'Write', description: 'Write files', parameters: {} },
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (toolName: string) => {
          if (toolName === 'Skill') {
            return {
              status: 'success',
              model: 'Skill activated',
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
            status: 'success',
            model: `Result of ${toolName}`,
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

    it('applies toolSourcePolicy when exposing tools for a turn', () => {
      const mm = createMockModelManager();
      const registry = new ToolRegistry();
      const catalog = new ToolCatalog(registry);

      catalog.register(
        createTool({
          name: 'BuiltinRead',
          displayName: 'Builtin Read',
          kind: ToolKind.ReadOnly,
          description: { short: 'Builtin tool' },
          schema: z.object({}),
          execute: () => completeToolExecution({
            status: 'success',
            model: 'builtin',
          }),
        }),
        {
          kind: 'builtin',
          trustLevel: 'trusted',
          sourceId: 'builtin',
        },
      );

      catalog.registerMcpTool(
        createTool({
          name: 'RemoteRead',
          displayName: 'Remote Read',
          kind: ToolKind.ReadOnly,
          description: { short: 'Remote tool' },
          schema: z.object({}),
          execute: () => completeToolExecution({
            status: 'success',
            model: 'remote',
          }),
        }),
        {
          kind: 'mcp',
          trustLevel: 'remote',
          sourceId: 'remote-server',
        },
      );

      const pipeline = {
        getRegistry: () => registry,
        getCatalog: () => catalog,
        execute: mockToolExecution(async (toolName: string) => ({
          status: 'success',
          model: `Result of ${toolName}`,
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(
        baseConfig,
        {
          toolSourcePolicy: {
            allowedSources: ['builtin'],
            allowedTrustLevels: ['trusted'],
          },
        },
        mm,
        pipeline,
      );

      const loopState = (
        runner as unknown as {
          createLoopState: (
            context: ChatContext,
            conversationState: ConversationState,
            permissionMode: PermissionMode,
          ) => { getTools(): Array<{ name: string }> };
        }
      ).createLoopState(createContext(), new ConversationState(null, [], { role: 'user', content: 'test' }), PermissionMode.DEFAULT);

      expect(loopState.getTools().map((tool) => tool.name)).toEqual(['BuiltinRead']);
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Read', description: 'Read files', parameters: {} },
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
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

    it('loads deferred tools on the next turn after DiscoverTools activation', async () => {
      const chatCalls: Array<Array<{ name: string }>> = [];
      const chatMessages: Message[][] = [];
      const chatFn = vi.fn(async (incomingMessages, tools) => {
        chatMessages.push(incomingMessages as Message[]);
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        chatCalls.push(tools as Array<{ name: string }>);

        if (toolNames.includes('DiscoverTools') && !toolNames.includes('HeavyInspect')) {
          return {
            content: 'Load hidden tool',
            toolCalls: [{
              id: 'discover-call',
              type: 'function' as const,
              function: { name: 'DiscoverTools', arguments: '{"query":"heavy"}' },
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

      const mm = createMockModelManager();
      mm.getChatService = () => ({
        chat: chatFn,
        streamChat: vi.fn(async function* () {}),
        getConfig: () => ({
          model: 'test-model',
          maxContextTokens: 128000,
          apiKey: 'test-key',
          baseUrl: 'https://test.com',
        }),
        updateConfig: vi.fn(() => {}),
      }) as never;

      const readTool = createTool({
        name: 'Read',
        displayName: 'Read',
        kind: ToolKind.ReadOnly,
        description: { short: 'Read tool' },
        schema: z.object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });
      const discoverTool = createTool({
        name: 'DiscoverTools',
        displayName: 'Discover Tools',
        kind: ToolKind.ReadOnly,
        description: { short: 'Discover hidden tools' },
        schema: z.object({ query: z.string() }),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });
      const heavyInspectTool = createTool({
        name: 'HeavyInspect',
        displayName: 'Heavy Inspect',
        kind: ToolKind.Execute,
        description: { short: 'Heavy inspection tool' },
        exposure: { mode: 'deferred', discoveryHint: 'Use for heavyweight inspection.' },
        schema: z.object({}),
        execute: () => completeToolExecution({ status: 'success', model: '' }),
      });

      const pipeline = {
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [readTool, discoverTool, heavyInspectTool],
          getFunctionDeclarationsByMode: () => [],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (toolName: string) => {
          if (toolName === 'DiscoverTools') {
            return {
              status: 'success',
              model: 'Loaded hidden tool',
              runtimePatch: {
                scope: 'session',
                source: 'tool',
                toolDiscovery: {
                  discover: ['HeavyInspect'],
                },
              },
            };
          }
          return {
            status: 'success',
            model: `Result of ${toolName}`,
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(chatCalls[0].map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['DiscoverTools', 'Read']),
      );
      expect(chatCalls[1].map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['DiscoverTools', 'HeavyInspect', 'Read']),
      );
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'ModelSwitch', description: 'Switch model', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Model switched',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'LegacyTool', description: 'Legacy tool', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Legacy result',
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

    it('does not derive runtime state from legacy metadata on Skill tools', async () => {
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
          content: 'Triggering legacy skill metadata',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Legacy skill result',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'error',
          model: 'failed',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Read', description: 'Read files', parameters: {} },
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Read', description: 'Read files', parameters: {} },
            { name: 'Write', description: 'Write files', parameters: {} },
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => {
          skillExecutions += 1;

          if (skillExecutions === 1) {
            return {
              status: 'success',
              model: 'Skill activated',
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
            status: 'success',
            model: 'Skill switched',
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
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
          } as RuntimePatch,
        })),
      } as unknown as ExecutionPipeline;

      const hookRuntime = new HookRuntime({
        sessionId: SessionId('test-session'),
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
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
          } as RuntimePatch,
        })),
      } as unknown as ExecutionPipeline;

      const hookRuntime = new HookRuntime({
        sessionId: SessionId('test-session'),
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
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
        getCatalog: () => undefined,
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
        execute: mockToolExecution(async (
          toolName: string,
          _params: Record<string, unknown>,
          executionContext: { contextSnapshot?: { environment?: Record<string, string> } },
        ) => {
          if (toolName === 'Skill') {
            return {
              status: 'success',
              model: 'Skill activated',
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
            status: 'success',
            model: 'Environment inspected',
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

    it('merges runtime system prompt appends from multiple runtime patches in application order', async () => {
      const chatFn = vi.fn(async (_messages, tools = []) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('PatchA')) {
          return {
            content: 'Apply patch A',
            toolCalls: [{
              id: 'patch-a-call',
              type: 'function' as const,
              function: { name: 'PatchA', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        if (toolNames.includes('PatchB')) {
          return {
            content: 'Apply patch B',
            toolCalls: [{
              id: 'patch-b-call',
              type: 'function' as const,
              function: { name: 'PatchB', arguments: '{}' },
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
          content: 'Apply patch A',
          toolCalls: [{
            id: 'patch-a-call',
            type: 'function' as const,
            function: { name: 'PatchA', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Apply patch B',
          toolCalls: [{
            id: 'patch-b-call',
            type: 'function' as const,
            function: { name: 'PatchB', arguments: '{}' },
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => {
            callCount += 1;
            if (callCount === 1) {
              return [{ name: 'PatchA', description: 'Patch A', parameters: {} }];
            }
            if (callCount === 2) {
              return [{ name: 'PatchB', description: 'Patch B', parameters: {} }];
            }
            return [];
          },
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (toolName: string) => ({
          status: 'success',
          model: `${toolName} applied`,
          runtimePatch: {
            scope: 'session',
            source: 'tool',
            systemPromptAppend: toolName === 'PatchA' ? 'PATCH A' : 'PATCH B',
          },
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(
        baseConfig,
        {
          systemPrompt: 'BASE PROMPT',
        },
        mm,
        pipeline,
      );

      const result = await runner.runLoop('Hello', createContext());
      expect(result.success).toBe(true);

      const prompt = await runner.buildSystemPromptOnDemand();
      expect(prompt).toBe('BASE PROMPT\n\n---\n\nPATCH A\n\n---\n\nPATCH B');
    });

    it('merges runtime environment overlays and records runtime patch provenance', async () => {
      const observedEnvironments: Array<Record<string, string> | undefined> = [];
      const chatFn = vi.fn(async (_messages, tools = []) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('PatchEnvA')) {
          return {
            content: 'Apply env patch A',
            toolCalls: [{
              id: 'patch-env-a-call',
              type: 'function' as const,
              function: { name: 'PatchEnvA', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        if (toolNames.includes('PatchEnvB')) {
          return {
            content: 'Apply env patch B',
            toolCalls: [{
              id: 'patch-env-b-call',
              type: 'function' as const,
              function: { name: 'PatchEnvB', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        if (toolNames.includes('EnvTool')) {
          return {
            content: 'Inspect env',
            toolCalls: [{
              id: 'env-tool-call',
              type: 'function' as const,
              function: { name: 'EnvTool', arguments: '{}' },
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
          content: 'Apply env patch A',
          toolCalls: [{
            id: 'patch-env-a-call',
            type: 'function' as const,
            function: { name: 'PatchEnvA', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Apply env patch B',
          toolCalls: [{
            id: 'patch-env-b-call',
            type: 'function' as const,
            function: { name: 'PatchEnvB', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Inspect env',
          toolCalls: [{
            id: 'env-tool-call',
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

      const saveToolUse = vi.fn()
        .mockResolvedValueOnce('tool-use-a')
        .mockResolvedValueOnce('tool-use-b')
        .mockResolvedValueOnce('tool-use-env');

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
          saveToolUse,
          saveToolResult: vi.fn(async () => 'uuid-3'),
          saveCompaction: vi.fn(async () => {}),
        }),
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async () => {}),
      } as unknown as MockModelManager;

      let callCount = 0;
      const pipeline = {
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => {
            callCount += 1;
            if (callCount === 1) {
              return [{ name: 'PatchEnvA', description: 'Patch env A', parameters: {} }];
            }
            if (callCount === 2) {
              return [{ name: 'PatchEnvB', description: 'Patch env B', parameters: {} }];
            }
            if (callCount === 3) {
              return [{ name: 'EnvTool', description: 'Inspect env', parameters: {} }];
            }
            return [];
          },
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (
          toolName: string,
          _params: Record<string, unknown>,
          executionContext: { contextSnapshot?: { environment?: Record<string, string> } },
        ) => {
          if (toolName === 'PatchEnvA') {
            return {
              status: 'success',
              model: 'Patch env A applied',
              runtimePatch: {
                scope: 'session',
                source: 'tool',
                environment: {
                  ENV_A: '1',
                  SHARED_ENV: 'a',
                },
              },
            };
          }

          if (toolName === 'PatchEnvB') {
            return {
              status: 'success',
              model: 'Patch env B applied',
              runtimePatch: {
                scope: 'session',
                source: 'tool',
                environment: {
                  ENV_B: '2',
                  SHARED_ENV: 'b',
                },
              },
            };
          }

          observedEnvironments.push(executionContext.contextSnapshot?.environment);
          return {
            status: 'success',
            model: 'Environment inspected',
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(observedEnvironments).toEqual([
        expect.objectContaining({
          ENV_A: '1',
          ENV_B: '2',
          SHARED_ENV: 'b',
        }),
      ]);
      expect(
        (runner as unknown as {
          getRuntimePatchApplications: () => Array<{
            provenance: { toolName: string; toolCallId: string; toolUseUuid: string | null };
          }>;
        }).getRuntimePatchApplications(),
      ).toEqual([
        expect.objectContaining({
          provenance: expect.objectContaining({
            toolName: 'PatchEnvA',
            toolCallId: 'patch-env-a-call',
            toolUseUuid: 'uuid-1',
          }),
        }),
        expect.objectContaining({
          provenance: expect.objectContaining({
            toolName: 'PatchEnvB',
            toolCallId: 'patch-env-b-call',
            toolUseUuid: 'uuid-1',
          }),
        }),
      ]);
    });

    it('applies ToolResult.contextPatch to subsequent tool executions in the same loop', async () => {
      const observedPageIds: Array<string | undefined> = [];
      const chatFn = vi.fn(async (_messages, tools = []) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('BrowserBootstrap')) {
          return {
            content: 'Bootstrap browser context',
            toolCalls: [{
              id: 'bootstrap-call',
              type: 'function' as const,
              function: { name: 'BrowserBootstrap', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        return {
          content: 'Inspect browser context',
          toolCalls: [{
            id: 'inspect-call',
            type: 'function' as const,
            function: { name: 'BrowserInspect', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      })
        .mockResolvedValueOnce({
          content: 'Bootstrap browser context',
          toolCalls: [{
            id: 'bootstrap-call',
            type: 'function' as const,
            function: { name: 'BrowserBootstrap', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Inspect browser context',
          toolCalls: [{
            id: 'inspect-call',
            type: 'function' as const,
            function: { name: 'BrowserInspect', arguments: '{}' },
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
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => {
            callCount += 1;
            if (callCount === 1) {
              return [{ name: 'BrowserBootstrap', description: 'Bootstrap browser context', parameters: {} }];
            }
            return [{ name: 'BrowserInspect', description: 'Inspect browser context', parameters: {} }];
          },
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (
          toolName: string,
          _params: Record<string, unknown>,
          executionContext: { contextSnapshot?: { context?: { capabilities?: { browser?: { pageId?: string } } } } },
        ) => {
          if (toolName === 'BrowserBootstrap') {
            return {
              status: 'success',
              model: 'Browser bootstrapped',
              contextPatch: {
                scope: 'session',
                context: {
                  capabilities: {
                    browser: {
                      pageId: 'page-123',
                    },
                  },
                },
              },
            };
          }

          observedPageIds.push(
            executionContext.contextSnapshot?.context?.capabilities?.browser?.pageId,
          );
          return {
            status: 'success',
            model: 'Browser inspected',
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext());

      expect(result.success).toBe(true);
      expect(observedPageIds).toEqual(['page-123']);
    });

    it('persists yielded newMessages after the tool result in session storage order', async () => {
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

      const saveMessage = vi.fn(async () => 'msg-uuid');
      const saveToolUse = vi.fn(async () => 'tool-use-uuid');
      const saveToolResult = vi.fn(async () => 'tool-result-uuid');
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
          saveMessage,
          saveToolUse,
          saveToolResult,
          saveCompaction: vi.fn(async () => {}),
        }),
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async () => {}),
      } as unknown as MockModelManager;

      const pipeline = {
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => [
            { name: 'Skill', description: 'Load a skill', parameters: {} },
          ],
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async () => ({
          status: 'success',
          model: 'Skill activated',
          newMessages: [
            { role: 'assistant', content: 'Injected assistant context' },
            { role: 'system', content: 'Injected system context' },
          ],
        })),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext({ sessionId: SessionId('sess-1') }));

      expect(result.success).toBe(true);
      expect(saveToolUse).not.toHaveBeenCalled();
      expect(saveToolResult).toHaveBeenCalled();
      const saveMessageCalls = saveMessage.mock.calls as unknown as Array<readonly unknown[]>;
      const assistantToolCallIndex = saveMessageCalls.findIndex((call) => {
        const metadata = call[4] as { toolCalls?: unknown[] } | undefined;
        return Boolean(metadata?.toolCalls?.length);
      });
      const injectedMessageIndex = saveMessageCalls.findIndex(
        (call) => call[2] === 'Injected assistant context',
      );
      expect(saveMessage.mock.invocationCallOrder[assistantToolCallIndex])
        .toBeLessThan(saveToolResult.mock.invocationCallOrder[0] ?? 0);
      expect(saveToolResult.mock.invocationCallOrder[0])
        .toBeLessThan(saveMessage.mock.invocationCallOrder[injectedMessageIndex] ?? 0);
      expect(saveMessage).toHaveBeenCalledWith(
        'sess-1',
        'assistant',
        'Injected assistant context',
        'tool-result-uuid',
        undefined,
        undefined,
      );
      expect(saveMessage).toHaveBeenCalledWith(
        'sess-1',
        'system',
        'Injected system context',
        'msg-uuid',
        { customMetadata: { _systemSource: 'tool_injection' } },
        undefined,
      );
    });

    it('consumes ToolResult.effects for context patches and injected messages', async () => {
      const observedPageIds: Array<string | undefined> = [];
      const saveMessage = vi.fn(async () => 'msg-uuid');
      const chatFn = vi.fn(async (_messages, tools = []) => {
        const toolNames = (tools as Array<{ name: string }>).map((tool) => tool.name);
        if (toolNames.includes('BrowserBootstrap')) {
          return {
            content: 'Bootstrap browser context',
            toolCalls: [{
              id: 'bootstrap-call',
              type: 'function' as const,
              function: { name: 'BrowserBootstrap', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        return {
          content: 'Inspect browser context',
          toolCalls: [{
            id: 'inspect-call',
            type: 'function' as const,
            function: { name: 'BrowserInspect', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      })
        .mockResolvedValueOnce({
          content: 'Bootstrap browser context',
          toolCalls: [{
            id: 'bootstrap-call',
            type: 'function' as const,
            function: { name: 'BrowserBootstrap', arguments: '{}' },
          }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          content: 'Inspect browser context',
          toolCalls: [{
            id: 'inspect-call',
            type: 'function' as const,
            function: { name: 'BrowserInspect', arguments: '{}' },
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
          saveMessage,
          saveToolUse: vi.fn(async () => 'uuid-2'),
          saveToolResult: vi.fn(async () => 'tool-result-uuid'),
          saveCompaction: vi.fn(async () => {}),
        }),
        getMaxContextTokens: () => 128000,
        switchModelIfNeeded: vi.fn(async () => {}),
      } as unknown as MockModelManager;

      let callCount = 0;
      const pipeline = {
        getCatalog: () => undefined,
        getRegistry: () => ({
          getAll: () => [],
          getFunctionDeclarationsByMode: () => {
            callCount += 1;
            if (callCount === 1) {
              return [{ name: 'BrowserBootstrap', description: 'Bootstrap browser context', parameters: {} }];
            }
            return [{ name: 'BrowserInspect', description: 'Inspect browser context', parameters: {} }];
          },
          get: (name: string) => ({ kind: 'execute', name }),
        }),
        execute: mockToolExecution(async (
          toolName: string,
          _params: Record<string, unknown>,
          executionContext: { contextSnapshot?: { context?: { capabilities?: { browser?: { pageId?: string } } } } },
        ) => {
          if (toolName === 'BrowserBootstrap') {
            return {
              status: 'success',
              model: 'Browser bootstrapped',
              effects: [
                {
                  type: 'contextPatch' as const,
                  patch: {
                    scope: 'session',
                    context: {
                      capabilities: {
                        browser: {
                          pageId: 'page-456',
                        },
                      },
                    },
                  },
                },
                {
                  type: 'newMessages' as const,
                  messages: [
                    { role: 'assistant' as const, content: 'Injected via effects' },
                  ],
                },
              ],
            };
          }

          observedPageIds.push(
            executionContext.contextSnapshot?.context?.capabilities?.browser?.pageId,
          );
          return {
            status: 'success',
            model: 'Browser inspected',
          };
        }),
      } as unknown as ExecutionPipeline;

      const runner = new LoopRunner(baseConfig, baseOptions, mm, pipeline);
      const result = await runner.runLoop('Hello', createContext({ sessionId: SessionId('sess-2') }));

      expect(result.success).toBe(true);
      expect(observedPageIds).toEqual(['page-456']);
      expect(saveMessage).toHaveBeenCalledWith(
        'sess-2',
        'assistant',
        'Injected via effects',
        'tool-result-uuid',
        undefined,
        undefined,
      );
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
