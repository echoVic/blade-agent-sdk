import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentKernelOptions } from '@blade-ai/agent/kernel';
import type { ModelPort } from '@blade-ai/ai';
import { createDefaultKernelSessionRuntimeFactory } from '../session/defaultKernelRuntimeFactory.js';
import { PackageLocalSession } from '../session/sessionInstance.js';
import { JsonlSessionStore } from '../session/store.js';
import type { SessionOptions, StreamMessage } from '../session/types.js';
import type { ToolDefinition } from '../tools/types/index.js';
import { HookEvent, PermissionMode } from '../types/constants.js';
import { createSdkMcpServer, tool } from '../local/mcp.js';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { MemoryManager } from '../local/MemoryManager.js';
import {
  type Memory,
  type MemoryInput,
  type MemoryStore,
} from '../local/memory.js';
import { createDefaultMcpRuntimeRegistry } from '../session/defaultMcpRuntime.js';
import { z } from 'zod';

const model: ModelPort = {
  async generate() {
    return { content: 'unused' };
  },
  async *stream() {},
};

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  temperature: 0.2,
  maxOutputTokens: 256,
  maxContextTokens: 4096,
  providerOptions: { routing: { tier: 'test' } },
  defaultContext: {
    capabilities: {
      filesystem: {
        cwd: '/workspace/project',
        roots: ['/workspace/project'],
      },
    },
  },
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-sdk-default-kernel-runtime-test-'));
}

describe('agent-sdk default kernel runtime factory', () => {
  it('does not report MCP health without an enabled health monitor', async () => {
    const handle = await createSdkMcpServer({
      name: 'capability-health-mcp',
      version: '1.0.0',
      tools: [
        tool('ping', 'Ping the local server', {}, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        })),
      ],
    });
    const registry = createDefaultMcpRuntimeRegistry();

    await registry.registerInProcessServer?.('local', handle);

    expect(await registry.getCapabilities()).toEqual([
      expect.objectContaining({
        name: 'local',
        status: 'connected',
        health: { enabled: false, status: 'disabled' },
      }),
    ]);
    await registry.disconnectAll();
  });

  it('shares one in-flight MCP connection across concurrent callers', async () => {
    const handle = await createSdkMcpServer({
      name: 'concurrent-connect-mcp',
      version: '1.0.0',
      tools: [
        tool('ping', 'Ping the local server', {}, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        })),
      ],
    });
    const createClientTransport = handle.createClientTransport;
    let releaseReconnect: (() => void) | undefined;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    let transportCount = 0;
    handle.createClientTransport = async () => {
      transportCount += 1;
      if (transportCount > 1) await reconnectGate;
      return createClientTransport();
    };
    const registry = createDefaultMcpRuntimeRegistry();

    await registry.registerInProcessServer?.('local', handle);
    await registry.disconnectServer?.('local');
    const firstConnect = registry.connectServer?.('local');
    const secondConnect = registry.connectServer?.('local');
    await Promise.resolve();
    releaseReconnect?.();
    await Promise.allSettled([firstConnect, secondConnect]);

    expect(transportCount).toBe(2);
    await registry.disconnectAll();
  });

  it('clears stale MCP capabilities when the active transport closes unexpectedly', async () => {
    const handle = await createSdkMcpServer({
      name: 'transport-close-mcp',
      version: '1.0.0',
      tools: [
        tool('ping', 'Ping the local server', {}, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        })),
      ],
    });
    const createClientTransport = handle.createClientTransport;
    let activeTransport: Awaited<ReturnType<typeof createClientTransport>> | undefined;
    handle.createClientTransport = async () => {
      activeTransport = await createClientTransport();
      return activeTransport;
    };
    const registry = createDefaultMcpRuntimeRegistry();

    await registry.registerInProcessServer?.('local', handle);
    await activeTransport?.close();
    await Promise.resolve();

    expect(await registry.getCapabilities()).toEqual([
      expect.objectContaining({
        name: 'local',
        status: 'disconnected',
        tools: [],
      }),
    ]);
  });

  it('connects and executes in-process MCP tools without injected MCP ports', async () => {
    const handle = await createSdkMcpServer({
      name: 'default-runtime-mcp',
      version: '1.0.0',
      tools: [
        tool(
          'lookup_release',
          'Lookup a release code',
          { project: z.string() },
          async ({ project }) => ({
            content: [{ type: 'text', text: `${project}: RELEASE-9` }],
          }),
        ),
      ],
    });
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'mcp-call',
            name: 'lookup_release',
            input: { project: 'blade' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'RELEASE-9',
        finishReason: 'stop',
      });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'default-mcp-session',
      createTurnId: () => 'default-mcp-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'default-mcp-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      mcpServers: { release: handle },
    });

    expect(await session.mcpListTools()).toEqual([
      {
        name: 'lookup_release',
        description: 'Lookup a release code',
        serverName: 'release',
      },
    ]);
    await session.send('Find the Blade release');
    const messages = await collect(session.stream());

    expect(generate.mock.calls[0]?.[0].tools).toEqual([
      expect.objectContaining({
        name: 'lookup_release',
        description: 'Lookup a release code',
      }),
    ]);
    expect(messages).toContainEqual({
      type: 'tool_result',
      id: 'mcp-call',
      name: 'lookup_release',
      output: 'blade: RELEASE-9',
      sessionId: 'default-mcp-session',
    });
    await session.close();
  });

  it('registers and executes session custom tools without injected tool runtime ports', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({
      success: true as const,
      data: { city, temperature: 23 },
      llmContent: `${city}: 23C`,
    }));
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'weather-call',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Beijing is 23C',
        finishReason: 'stop',
      });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'default-tool-session',
      createTurnId: () => 'default-tool-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'default-tool-model' },
            };
          },
        },
      },
    });
    const customTool: ToolDefinition<{ city: string }> = {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
      execute,
    };

    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      tools: [customTool],
      hooks: {
        [HookEvent.PreToolUse]: [
          async () => ({
            action: 'continue',
            modifiedInput: { city: 'Shanghai' },
          }),
        ],
        [HookEvent.PostToolUse]: [
          async () => ({
            action: 'continue',
            modifiedOutput: 'hooked weather result',
          }),
        ],
      },
    });
    await session.send('What is the weather in Beijing?');

    const messages = await collect(session.stream());

    expect(generate.mock.calls[0]?.[0].tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: customTool.parameters,
      },
    ]);
    expect(execute).toHaveBeenCalledWith(
      { city: 'Shanghai' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(messages).toEqual(expect.arrayContaining([
      {
        type: 'tool_use',
        id: 'weather-call',
        name: 'get_weather',
        input: { city: 'Beijing' },
        sessionId: 'default-tool-session',
      },
      {
        type: 'tool_result',
        id: 'weather-call',
        name: 'get_weather',
        output: 'hooked weather result',
        sessionId: 'default-tool-session',
      },
      {
        type: 'result',
        subtype: 'success',
        content: 'Beijing is 23C',
        sessionId: 'default-tool-session',
      },
    ]));
  });

  it('executes prebuilt local tools passed through session options', async () => {
    const memory: Memory = {
      name: 'project-context',
      description: 'Repository conventions',
      type: 'project',
      body: 'Keep local tools explicitly composed.',
      updatedAt: 1,
    };
    const memoryStore: MemoryStore = {
      async save(input: MemoryInput) {
        return { ...input, updatedAt: 1 };
      },
      async get(name: string) {
        return name === memory.name ? memory : undefined;
      },
      async list() {
        return [memory];
      },
      async delete() {},
    };
    const localTools = await getBuiltinTools({
      memoryManager: new MemoryManager(memoryStore),
    });
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'memory-read-call',
            name: 'MemoryRead',
            input: { operation: 'get', name: memory.name },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Loaded project context',
        finishReason: 'stop',
      });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'local-tool-session',
      createTurnId: () => 'local-tool-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'local-tool-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      tools: localTools,
    });
    await session.send('Load project context');
    const messages = await collect(session.stream());

    expect(generate.mock.calls[0]?.[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'MemoryRead' }),
        expect.objectContaining({ name: 'MemoryWrite' }),
      ]),
    );
    expect(messages).toEqual(expect.arrayContaining([
      {
        type: 'tool_result',
        id: 'memory-read-call',
        name: 'MemoryRead',
        output: memory,
        sessionId: 'local-tool-session',
      },
      {
        type: 'result',
        subtype: 'success',
        content: 'Loaded project context',
        sessionId: 'local-tool-session',
      },
    ]));
  });

  it('rechecks path safety after PreToolUse hooks rewrite tool input', async () => {
    const execute = vi.fn(async ({ file_path }: { file_path: string }) => ({
      success: true as const,
      llmContent: file_path,
    }));
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'path-call',
            name: 'read_path',
            input: { file_path: '/tmp/safe.txt' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'path rejected',
        finishReason: 'stop',
      });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'path-safety-session',
      createTurnId: () => 'path-safety-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'path-safety-model' },
            };
          },
        },
      },
    });
    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      tools: [{
        name: 'read_path',
        description: 'Read a path',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
        execute,
      }],
      hooks: {
        [HookEvent.PreToolUse]: [
          async () => ({
            action: 'continue',
            modifiedInput: { file_path: '/etc/passwd' },
          }),
        ],
      },
    });

    await session.send('Read the safe path');
    const messages = await collect(session.stream());

    expect(execute).not.toHaveBeenCalled();
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      id: 'path-call',
      name: 'read_path',
      isError: true,
      output: expect.stringContaining('Access to dangerous system paths denied'),
    }));
    await session.close();
  });

  it('does not execute tools after the turn signal aborts before tool execution', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      success: true as const,
      llmContent: 'should not run',
    }));
    const generate = vi.fn<ModelPort['generate']>(async () => {
      controller.abort('cancel before tool execution');
      return {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'abort-call', name: 'abort_tool', input: {} }],
      };
    });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'abort-session',
      createTurnId: () => 'abort-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'abort-model' },
            };
          },
        },
      },
    });
    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      tools: [{
        name: 'abort_tool',
        description: 'Must not run after abort',
        parameters: { type: 'object', properties: {} },
        execute,
      }],
    });

    await session.send('Abort the tool', { signal: controller.signal });
    await collect(session.stream());

    expect(execute).not.toHaveBeenCalled();
    await session.close();
  });

  it('does not execute tools when permission resolution aborts the turn', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      success: true as const,
      llmContent: 'should not run',
    }));
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'permission-abort-call', name: 'permission_abort_tool', input: {} }],
      })
      .mockResolvedValueOnce({ content: 'cancelled', finishReason: 'stop' });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'permission-abort-session',
      createTurnId: () => 'permission-abort-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'permission-abort-model' },
            };
          },
        },
      },
    });
    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      permissionHandler: async () => {
        controller.abort('cancel during permission');
        return { behavior: 'allow' };
      },
      tools: [{
        name: 'permission_abort_tool',
        description: 'Must not run after permission abort',
        parameters: { type: 'object', properties: {} },
        execute,
      }],
    });

    await session.send('Abort during permission', { signal: controller.signal });
    await collect(session.stream());

    expect(execute).not.toHaveBeenCalled();
    await session.close();
  });

  it('runs PostToolUseFailure hooks when custom tool execution throws', async () => {
    const failureHook = vi.fn(async () => ({
      action: 'continue' as const,
      modifiedOutput: 'failure handled by hook',
    }));
    const generate = vi
      .fn<ModelPort['generate']>()
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'throw-call', name: 'throw_tool', input: {} }],
      })
      .mockResolvedValueOnce({ content: 'handled', finishReason: 'stop' });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'throw-session',
      createTurnId: () => 'throw-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: { generate, async *stream() {} },
              modelRequestDefaults: { model: 'throw-model' },
            };
          },
        },
      },
    });
    const session = await factory.create({
      ...options,
      permissionMode: PermissionMode.YOLO,
      tools: [{
        name: 'throw_tool',
        description: 'Throws during execution',
        parameters: { type: 'object', properties: {} },
        async execute() {
          throw new Error('tool exploded');
        },
      }],
      hooks: {
        [HookEvent.PostToolUseFailure]: [failureHook],
      },
    });

    await session.send('Run the throwing tool');
    const messages = await collect(session.stream());

    expect(failureHook).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'throw_tool',
      error: expect.objectContaining({ message: expect.stringContaining('tool exploded') }),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      id: 'throw-call',
      isError: true,
      output: 'failure handled by hook',
    }));
    await session.close();
  });

  it('uses the package-local AgentKernel factory when no kernel factory is injected', async () => {
    const generate = vi.fn(async () => ({
      content: 'default kernel answer',
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      },
      finishReason: 'stop' as const,
    }));
    const defaultKernelModel: ModelPort = {
      generate,
      async *stream() {},
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'default-kernel-session',
      createTurnId: () => 'default-kernel-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: defaultKernelModel,
              modelRequestDefaults: {
                model: 'default-kernel-model',
                temperature: 0.4,
                maxOutputTokens: 512,
                maxContextTokens: 8192,
              },
            };
          },
        },
      },
    });

    const session = await factory.create(options);
    await session.send('hello from default kernel');

    await expect(collect(session.stream())).resolves.toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'default-kernel-session' },
      { type: 'content', delta: 'default kernel answer', sessionId: 'default-kernel-session' },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          maxContextTokens: 8192,
        },
        sessionId: 'default-kernel-session',
      },
      { type: 'turn_end', turn: 1, sessionId: 'default-kernel-session' },
      {
        type: 'result',
        subtype: 'success',
        content: 'default kernel answer',
        sessionId: 'default-kernel-session',
      },
    ]);
    expect(generate).toHaveBeenCalledWith({
      model: 'default-kernel-model',
      temperature: 0.4,
      maxOutputTokens: 512,
      maxContextTokens: 8192,
      messages: [{ role: 'user', content: 'hello from default kernel' }],
      signal: expect.any(AbortSignal),
    });
  });

  it('applies setModel to the package-local kernel runtime before resolving turns', async () => {
    const resolvedModels: string[] = [];
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'model-switch-session',
      createTurnId: () => 'model-switch-turn',
      runtime: {
        kernelModelResolver: {
          resolve(resolveOptions) {
            const modelName = resolveOptions.bladeConfig.models[0]?.model;
            resolvedModels.push(modelName ?? 'missing');
            return {
              model,
              modelRequestDefaults: { model: modelName ?? 'missing' },
            };
          },
        },
        kernelFactory: {
          create(createOptions) {
            return {
              async *runTurn() {
                yield {
                  type: 'result' as const,
                  content: createOptions.modelRequestDefaults?.model ?? 'missing',
                };
              },
            };
          },
        },
      },
    });

    const session = await factory.create({ ...options, model: 'model-a' });
    await session.setModel('model-b');
    await session.send('use switched model');

    await expect(collect(session.stream())).resolves.toContainEqual({
      type: 'result',
      subtype: 'success',
      content: 'model-b',
      sessionId: 'model-switch-session',
    });
    expect(resolvedModels).toEqual(['model-b']);
  });

  it('assembles package-local kernel sessions from session options and runtime ports', async () => {
    const kernelOptions: AgentKernelOptions[] = [];
    const turns: Array<{ input: string; turnId?: string; signal?: AbortSignal }> = [];
    const disconnectAll = vi.fn();
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'kernel-session',
      createTurnId: () => 'kernel-turn',
      runtime: {
        mcpRegistry: {
          disconnectAll,
          async getCapabilities() {
            return [];
          },
        },
        kernelModelResolver: {
          resolve(resolveOptions) {
            expect(resolveOptions.modelId).toBeUndefined();
            expect(resolveOptions.bladeConfig.currentModelId).toBe('default');
            expect(resolveOptions.bladeConfig.models[0]).toMatchObject({
              model: 'test-model',
              temperature: 0.2,
              maxOutputTokens: 256,
              maxContextTokens: 4096,
              providerOptions: { routing: { tier: 'test' } },
            });
            return {
              model,
              modelRequestDefaults: {
                model: 'test-model',
                temperature: 0.2,
                maxOutputTokens: 256,
                maxContextTokens: 4096,
                providerOptions: { routing: { tier: 'test' } },
              },
            };
          },
        },
        kernelFactory: {
          create(createOptions) {
            kernelOptions.push(createOptions);
            return {
              async *runTurn(turn) {
                turns.push(turn);
                yield { type: 'content' as const, delta: `echo:${turn.input}` };
                yield {
                  type: 'usage' as const,
                  usage: {
                    promptTokens: 1,
                    completionTokens: 2,
                    totalTokens: 3,
                  },
                };
                yield { type: 'result' as const, content: 'done' };
              },
            };
          },
        },
      },
    });

    const session = await factory.create(options);

    expect(session).toBeInstanceOf(PackageLocalSession);
    expect(session.sessionId).toBe('kernel-session');
    expect(session.getDefaultContext()).toEqual(options.defaultContext);
    await session.send('hello', { maxTurns: 5 });
    await expect(collect(session.stream())).resolves.toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'kernel-session' },
      { type: 'content', delta: 'echo:hello', sessionId: 'kernel-session' },
      {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          maxContextTokens: 4096,
        },
        sessionId: 'kernel-session',
      },
      { type: 'turn_end', turn: 1, sessionId: 'kernel-session' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'kernel-session' },
    ]);
    await session.close();

    expect(kernelOptions).toHaveLength(1);
    expect(kernelOptions[0]).toMatchObject({
      model,
      modelRequestDefaults: {
        model: 'test-model',
        temperature: 0.2,
        maxOutputTokens: 256,
        maxContextTokens: 4096,
        providerOptions: { routing: { tier: 'test' } },
      },
      maxSteps: 5,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ input: 'hello', turnId: 'kernel-turn' });
    expect(turns[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('applies UserPromptSubmit hooks through the default package-local hook runtime', async () => {
    const generate = vi.fn(async () => ({
      content: 'hooked answer',
      finishReason: 'stop' as const,
    }));
    const defaultKernelModel: ModelPort = {
      generate,
      async *stream() {},
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'hook-session',
      createTurnId: () => 'hook-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: defaultKernelModel,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async () => ({
            action: 'continue',
            modifiedInput: { userPrompt: 'updated prompt' },
          }),
        ],
      },
    });

    await session.send('original prompt');
    await collect(session.stream());

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'updated prompt' }],
      }),
    );
  });

  it('runs SessionStart hooks during package-local session initialization', async () => {
    const sessionStart = vi.fn(async () => ({
      action: 'continue' as const,
    }));
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'start-hook-session',
      createTurnId: () => 'start-hook-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      hooks: {
        [HookEvent.SessionStart]: [sessionStart],
      },
    });

    expect(session.sessionId).toBe('start-hook-session');
    expect(sessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        event: HookEvent.SessionStart,
        sessionId: 'start-hook-session',
        isResume: false,
        model: 'test-model',
        provider: 'openai-compatible',
      }),
    );
  });

  it('runs SessionEnd hooks when closing package-local sessions', async () => {
    const sessionEnd = vi.fn(async () => ({
      action: 'continue' as const,
    }));
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'end-hook-session',
      createTurnId: () => 'end-hook-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      hooks: {
        [HookEvent.SessionEnd]: [sessionEnd],
      },
    });

    await session.close();

    expect(sessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        event: HookEvent.SessionEnd,
        sessionId: 'end-hook-session',
        reason: 'other',
      }),
    );
  });

  it('initializes configured runtime capabilities before package-local kernel turns', async () => {
    const order: string[] = [];
    const registerServer = vi.fn(async (serverName: string) => {
      order.push(`mcp:${serverName}`);
    });
    const registerAll = vi.fn((tools: Array<{ name: string }>, source: { kind: string }) => {
      order.push(`register:${source.kind}:${tools.map((tool) => tool.name).join(',')}`);
    });
    const customTool: ToolDefinition = {
      name: 'custom_tool',
      description: 'Custom test tool',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        return {
          success: true,
          data: 'ok',
          llmContent: 'ok',
        };
      },
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'capability-session',
      createTurnId: () => 'capability-turn',
      runtime: {
        mcpRegistry: {
          disconnectAll: vi.fn(async () => {}),
          registerServer,
          async getCapabilities() {
            return [];
          },
          async getAvailableToolsByServerNames(serverNames) {
            order.push(`mcp-tools:${serverNames.join(',')}`);
            return [];
          },
        },
        toolCatalog: {
          registerAll,
          registerMcpTool: vi.fn(),
          removeMcpTools: vi.fn((serverName: string) => {
            order.push(`mcp-remove:${serverName}`);
            return 0;
          }),
        },
        customToolFactory: {
          fromDefinition(definition) {
            order.push(`custom:${definition.name}`);
            return { name: definition.name };
          },
        },
        builtinToolProvider: {
          async getTools(context) {
            order.push(`builtin:${context.sessionId}:${context.includeMcpProtocolTools}`);
            return [{ name: 'builtin_tool' }];
          },
        },
        hookManager: {
          enable() {
            order.push('hooks');
          },
        },
        subagentRegistry: {
          setLogger() {
            order.push('subagent-logger');
          },
          setProjectDir() {
            order.push('subagent-project');
          },
          loadFromStandardLocations() {
            order.push('subagent-load');
            return 0;
          },
          register(config) {
            order.push(`subagent:${config.name}`);
          },
        },
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
        kernelFactory: {
          create() {
            return {
              async *runTurn() {
                order.push('kernel');
                yield { type: 'result' as const, content: 'done' };
              },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      hooks: {
        [HookEvent.SessionStart]: [async () => ({ action: 'continue' })],
      },
      tools: [customTool],
      agents: {
        reviewer: {
          name: 'reviewer',
          description: 'Reviews output',
          allowedTools: ['custom_tool'],
        },
      },
      mcpServers: {
        remote: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    await session.send('run with configured capabilities');
    await collect(session.stream());

    expect(order).toEqual([
      'mcp:remote',
      'mcp-remove:remote',
      'mcp-tools:remote',
      'custom:custom_tool',
      'register:custom:custom_tool',
      'builtin:capability-session:false',
      'register:builtin:builtin_tool',
      'subagent-logger',
      'subagent-project',
      'subagent-load',
      'subagent:reviewer',
      'hooks',
      'kernel',
    ]);
    expect(registerServer).toHaveBeenCalledWith('remote', {
      command: 'node',
      args: ['server.js'],
    });
  });

  it('routes package-local session MCP actions through the kernel runtime', async () => {
    const connectServer = vi.fn(async () => {});
    const disconnectServer = vi.fn(async () => {});
    const reconnectServer = vi.fn(async () => {});
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'mcp-session',
      createTurnId: () => 'mcp-turn',
      runtime: {
        mcpRegistry: {
          disconnectAll: vi.fn(async () => {}),
          connectServer,
          disconnectServer,
          reconnectServer,
          async getCapabilities() {
            return [
              {
                name: 'remote',
                status: 'connected',
                auth: { enabled: false },
                health: { enabled: false, status: 'disabled' },
                tools: [{ name: 'remote_tool', description: 'Remote tool', inputSchema: {} }],
              },
            ];
          },
          async getAvailableToolsByServerNames() {
            return [];
          },
        },
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      mcpServers: {
        remote: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    await session.mcpConnect('remote');
    await session.mcpDisconnect('remote');
    await session.mcpReconnect('remote');

    expect(connectServer).toHaveBeenCalledWith('remote');
    expect(disconnectServer).toHaveBeenCalledWith('remote');
    expect(reconnectServer).toHaveBeenCalledWith('remote');
  });

  it('forks resumed sessions by materializing package-local JSONL history', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const store = new JsonlSessionStore(workspaceRoot);
    const sourceSnapshot = await store.writeForkState('parent-session', {
      sessionId: 'root-session',
      messages: [
        { id: 'message-1', role: 'user', content: 'hello' },
        { id: 'message-2', role: 'assistant', content: 'hi' },
        { id: 'message-3', role: 'user', content: 'later' },
      ],
      messageIds: ['message-1', 'message-2', 'message-3'],
      lastActivity: Date.now(),
    });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'forked-session',
      createTurnId: () => 'forked-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    expect(sourceSnapshot?.messageIds).toEqual(['message-1', 'message-2', 'message-3']);

    const source = await factory.resume({
      ...options,
      storagePath: workspaceRoot,
      sessionId: 'parent-session',
    });
    const forked = await source.fork({ messageId: 'message-2' });
    const forkedState = await store.loadState(forked.sessionId);

    expect(forked).toBeInstanceOf(PackageLocalSession);
    expect(forked.sessionId).toBe('forked-session');
    expect(forkedState?.messageIds).toEqual(['message-1', 'message-2']);
    expect(forkedState?.messages.map((message) => message.content)).toEqual(['hello', 'hi']);
    expect(forkedState?.sessionInfo).toMatchObject({
      sessionId: 'forked-session',
      parentId: 'parent-session',
    });
  });

  it('persists default kernel turn messages through the package-local JSONL store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const generate = vi.fn(async () => ({
      content: 'persisted answer',
      reasoningContent: 'persisted reasoning',
      finishReason: 'stop' as const,
    }));
    const defaultKernelModel: ModelPort = {
      generate,
      async *stream() {},
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'persisted-session',
      createTurnId: () => 'persisted-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: defaultKernelModel,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });
    const store = new JsonlSessionStore(workspaceRoot);

    const session = await factory.create({
      ...options,
      storagePath: workspaceRoot,
    });
    await session.send('persist this turn');
    await collect(session.stream());

    await expect(store.loadState('persisted-session')).resolves.toMatchObject({
      sessionId: 'persisted-session',
      messages: [
        {
          role: 'user',
          content: 'persist this turn',
          metadata: {
            kernel: {
              turnId: 'persisted-turn',
              source: 'input',
              step: 0,
            },
          },
        },
        {
          role: 'assistant',
          content: 'persisted answer',
          reasoningContent: 'persisted reasoning',
          metadata: {
            kernel: {
              turnId: 'persisted-turn',
              source: 'model',
              step: 1,
            },
          },
        },
      ],
      messageIds: expect.any(Array),
    });
  });

  it('refreshes session messages after persisted default kernel turns', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const defaultKernelModel: ModelPort = {
      async generate() {
        return {
          content: 'fresh answer',
          finishReason: 'stop' as const,
        };
      },
      async *stream() {},
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'fresh-session',
      createTurnId: () => 'fresh-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: defaultKernelModel,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      storagePath: workspaceRoot,
    });
    await session.send('refresh this turn');
    await collect(session.stream());

    expect(session.messages).toMatchObject([
      {
        role: 'user',
        content: 'refresh this turn',
        metadata: {
          kernel: {
            turnId: 'fresh-turn',
            source: 'input',
            step: 0,
          },
        },
      },
      {
        role: 'assistant',
        content: 'fresh answer',
        metadata: {
          kernel: {
            turnId: 'fresh-turn',
            source: 'model',
            step: 1,
          },
        },
      },
    ]);
  });

  it('records default kernel traces through the package-local session runtime', async () => {
    const sink = vi.fn();
    const defaultKernelModel: ModelPort = {
      async generate() {
        return {
          content: 'traced answer',
          usage: {
            promptTokens: 5,
            completionTokens: 7,
            totalTokens: 12,
          },
          finishReason: 'stop' as const,
        };
      },
      async *stream() {},
    };
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'traced-session',
      createTurnId: () => 'traced-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model: defaultKernelModel,
              modelRequestDefaults: {
                model: 'test-model',
                maxContextTokens: 4096,
              },
            };
          },
        },
      },
    });

    const session = await factory.create({
      ...options,
      observability: {
        enabled: true,
        capturePayloads: true,
        sink,
      },
    });
    await session.send('trace this turn');
    await collect(session.stream());

    const trace = session.getLastTrace();
    expect(trace).toMatchObject({
      sessionId: 'traced-session',
      status: 'success',
      metadata: {
        model: 'test-model',
        provider: 'openai-compatible',
        permissionMode: 'default',
      },
    });
    expect(trace?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'user_prompt',
        'turn_start',
        'model_request',
        'model_response',
        'usage',
        'turn_end',
        'result',
      ]),
    );
    expect(trace?.events.find((event) => event.type === 'usage')?.data?.usage).toMatchObject({
      value: {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        maxContextTokens: 4096,
      },
    });
    expect(JSON.stringify(trace)).toContain('trace this turn');
    expect(JSON.stringify(trace)).toContain('traced answer');
    expect(session.getTraces()).toEqual([trace]);
    expect(sink).toHaveBeenCalledWith(trace);
  });

  it('persists create and resume lifecycle through the package-local JSONL store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'empty-session',
      createTurnId: () => 'unused-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });
    const store = new JsonlSessionStore(workspaceRoot);

    const created = await factory.create({
      ...options,
      storagePath: workspaceRoot,
    });
    const resumed = await factory.resume({
      ...options,
      storagePath: workspaceRoot,
      sessionId: 'missing-session',
    });

    await expect(store.loadState(created.sessionId)).resolves.toMatchObject({
      sessionId: 'empty-session',
      messages: [],
      messageIds: [],
      sessionInfo: {
        sessionId: 'empty-session',
      },
    });
    await expect(store.loadState(resumed.sessionId)).resolves.toMatchObject({
      sessionId: 'missing-session',
      messages: [],
      messageIds: [],
      sessionInfo: {
        sessionId: 'missing-session',
      },
    });
  });

  it('hydrates resumed session messages from package-local JSONL history', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const store = new JsonlSessionStore(workspaceRoot);
    await store.writeForkState('history-session', {
      sessionId: 'root-session',
      messages: [
        { id: 'message-1', role: 'user', content: 'remember me' },
        { id: 'message-2', role: 'assistant', content: 'remembered' },
      ],
      messageIds: ['message-1', 'message-2'],
      lastActivity: Date.now(),
    });
    const factory = createDefaultKernelSessionRuntimeFactory({
      createSessionId: () => 'unused-session',
      createTurnId: () => 'unused-turn',
      runtime: {
        kernelModelResolver: {
          resolve() {
            return {
              model,
              modelRequestDefaults: { model: 'test-model' },
            };
          },
        },
      },
    });

    const session = await factory.resume({
      ...options,
      storagePath: workspaceRoot,
      sessionId: 'history-session',
    });

    expect(session.messages).toEqual([
      { id: 'message-1', role: 'user', content: 'remember me' },
      { id: 'message-2', role: 'assistant', content: 'remembered' },
    ]);
  });
});
