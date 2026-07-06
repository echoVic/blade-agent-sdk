import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentKernelOptions } from '@blade-ai/agent';
import type { ModelPort } from '@blade-ai/ai';
import { createDefaultKernelSessionRuntimeFactory } from '../../packages/agent-sdk/src/session/defaultKernelRuntimeFactory.js';
import { JsonlSessionStore } from '../../packages/agent-sdk/src/session/store.js';
import { PackageLocalSession } from '../../packages/agent-sdk/src/session/sessionInstance.js';
import type { SessionOptions, StreamMessage } from '../../packages/agent-sdk/src/session/types.js';
import type { ToolDefinition } from '../../packages/agent-sdk/src/tools/types/index.js';
import { HookEvent } from '../../packages/agent-sdk/src/types/constants.js';

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
