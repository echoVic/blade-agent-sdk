import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelPort } from '@blade-ai/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDefined } from '../../__tests__/helpers/assertDefined.js';
import { HookManager } from '../../hooks/HookManager.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import { TraceRecorder } from '../../observability/TraceRecorder.js';
import { createContextSnapshot, type RuntimeContext } from '../../runtime/index.js';
import type { ToolDefinition, ToolResult } from '../../tools/types/index.js';
import { SessionId } from '../../types/branded.js';
import type { JsonObject } from '../../types/common.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import type { SessionOptions } from '../types.js';

const mockConnect = vi.fn(() => Promise.resolve());
const mockDisconnect = vi.fn(() => Promise.resolve());
const mockOn = vi.fn(() => {});

vi.mock('../../mcp/McpClient.js', () => ({
  McpClient: class MockMcpClient {
    availableTools = [
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      },
    ];
    connect = mockConnect;
    disconnect = mockDisconnect;
    on = mockOn;
  },
}));

const { SessionRuntime } = await import('../SessionRuntime.js');

const customTool: ToolDefinition<{ value?: string }> = {
  name: 'CustomTool',
  description: 'Custom test tool',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
  },
  async execute() {
    return {
      success: true,
      llmContent: 'ok',
    };
  },
};

function createOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    provider: { type: 'openai-compatible', apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    storagePath: overrides.storagePath,
    ...overrides,
  };
}

function createFilesystemContext(workspaceRoot: string): RuntimeContext {
  return {
    capabilities: {
      filesystem: {
        roots: [workspaceRoot],
        cwd: workspaceRoot,
      },
    },
  };
}

describe('SessionRuntime', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-runtime-test-'));
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockOn.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const runtime = new SessionRuntime(
      SessionId('cleanup'),
      createOptions(),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );
    await runtime.close();
  });

  it('should apply allowedTools/disallowedTools to the runtime registry', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-1'),
      createOptions({
        allowedTools: ['Read', 'CustomTool'],
        disallowedTools: ['Read'],
        tools: [customTool],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const toolNames = runtime.getToolRegistry().getAll().map((tool) => tool.name);
    expect(toolNames).toEqual(['CustomTool']);
    expect(runtime.getToolCatalog().getEntry('CustomTool')).toMatchObject({
      source: {
        kind: 'custom',
        trustLevel: 'workspace',
        sourceId: 'session',
      },
    });

    await runtime.close();
  });

  it('should expose registered session tools through the kernel tool port', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-kernel-tools'),
      createOptions({
        allowedTools: ['CustomTool'],
        tools: [customTool],
      }),
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const toolPort = runtime.getKernelToolPort(() => ({ userId: 'sdk-user' }));

    await expect(toolPort.list()).resolves.toEqual([
      { id: 'CustomTool', name: 'CustomTool', input: {} },
    ]);
    await expect(toolPort.execute({
      id: 'call_custom',
      name: 'CustomTool',
      input: { value: 'blade' },
    })).resolves.toEqual({
      id: 'call_custom',
      name: 'CustomTool',
      output: 'ok',
    });

    await runtime.close();
  });

  it('should persist kernel store messages through the runtime context manager', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-kernel-store'),
      createOptions(),
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();
    await runtime.ensureSessionCreated();

    const storePort = runtime.getKernelStorePort();
    await storePort.appendMessage(
      { role: 'user', content: 'Persist from kernel' },
      { turnId: 'turn_store', source: 'input', step: 0 },
    );
    await storePort.appendMessage(
      { role: 'assistant', content: 'Stored by session runtime' },
      { turnId: 'turn_store', source: 'model', step: 1 },
    );

    const contextManager = runtime.getAgentRuntimeDeps().contextManager;
    assertDefined(contextManager);
    const formatted = await contextManager.getFormattedContext();

    expect(formatted.context.layers.conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    }))).toEqual([
      {
        role: 'user',
        content: 'Persist from kernel',
        metadata: { kernel: { turnId: 'turn_store', source: 'input', step: 0 } },
      },
      {
        role: 'assistant',
        content: 'Stored by session runtime',
        metadata: { kernel: { turnId: 'turn_store', source: 'model', step: 1 } },
      },
    ]);

    await runtime.close();
  });

  it('should reload persisted kernel store message metadata', async () => {
    const sessionId = SessionId('session-kernel-store-reload');
    const storagePath = join(workspaceRoot, 'sessions');
    const options = createOptions({ storagePath });
    const runtime = new SessionRuntime(
      sessionId,
      options,
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();
    await runtime.ensureSessionCreated();
    await runtime.getKernelStorePort().appendMessage(
      {
        role: 'assistant',
        content: 'Persisted answer',
        reasoningContent: 'persisted thought',
        toolCalls: [{ id: 'call_reload', name: 'Search', input: { q: 'blade' } }],
      },
      { turnId: 'turn_reload', source: 'model', step: 1 },
    );
    await runtime.close();

    const resumed = new SessionRuntime(
      sessionId,
      options,
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await resumed.initialize();
    await resumed.ensureSessionLoaded();
    const contextManager = resumed.getAgentRuntimeDeps().contextManager;
    assertDefined(contextManager);
    const formatted = await contextManager.getFormattedContext();

    expect(formatted.context.layers.conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    }))).toEqual([
      {
        role: 'assistant',
        content: 'Persisted answer',
        metadata: {
          kernel: { turnId: 'turn_reload', source: 'model', step: 1 },
          reasoningContent: 'persisted thought',
          toolCalls: [
            {
              id: 'call_reload',
              type: 'function',
              function: {
                name: 'Search',
                arguments: '{"q":"blade"}',
              },
            },
          ],
        },
      },
    ]);

    await resumed.close();
  });

  it('should expose kernel trace events through the runtime trace port', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-kernel-trace'),
      createOptions(),
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const recorder = new TraceRecorder(SessionId('session-kernel-trace'), {
      enabled: true,
      capturePayloads: true,
    });
    const tracePort = runtime.getKernelTracePort(recorder);
    await tracePort.record({ type: 'turn_start', input: 'Trace from kernel' });
    await tracePort.record({ type: 'turn_end', content: 'Traced answer', finishReason: 'stop' });

    expect(recorder.getTrace().events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn_start', 'turn_end']),
    );

    await runtime.close();
  });

  it('should compose an AgentKernel with session store and trace adapters', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-kernel-runtime'),
      createOptions(),
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );
    const model: ModelPort = {
      generate: vi.fn(async () => ({
        content: 'Kernel answer',
        usage: {
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        },
        finishReason: 'stop',
      })),
      stream: async function* () {},
    };
    const recorder = new TraceRecorder(SessionId('session-kernel-runtime'), {
      enabled: true,
      capturePayloads: true,
    });

    await runtime.initialize();
    await runtime.ensureSessionCreated();

    const kernel = runtime.createAgentKernel({ model, traceRecorder: recorder });
    const events = [];
    for await (const event of kernel.runTurn({
      input: 'Run through kernel',
      turnId: 'turn_kernel_runtime',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'content', delta: 'Kernel answer' },
      {
        type: 'usage',
        usage: {
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        },
      },
      { type: 'result', content: 'Kernel answer', finishReason: 'stop' },
    ]);

    const contextManager = runtime.getAgentRuntimeDeps().contextManager;
    assertDefined(contextManager);
    const formatted = await contextManager.getFormattedContext();
    expect(formatted.context.layers.conversation.messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    }))).toEqual([
      {
        role: 'user',
        content: 'Run through kernel',
        metadata: { kernel: { turnId: 'turn_kernel_runtime', source: 'input', step: 0 } },
      },
      {
        role: 'assistant',
        content: 'Kernel answer',
        metadata: { kernel: { turnId: 'turn_kernel_runtime', source: 'model', step: 1 } },
      },
    ]);
    expect(recorder.getTrace().events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn_start', 'model_request', 'model_response', 'usage', 'turn_end']),
    );

    await runtime.close();
  });

  it('should disable all tools when allowedTools is an empty array', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-empty-allowlist'),
      createOptions({
        allowedTools: [],
        tools: [customTool],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    expect(runtime.getToolRegistry().getAll()).toEqual([]);

    await runtime.close();
  });

  it('should refresh MCP tools on disconnect and reconnect', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-2'),
      createOptions({
        mcpServers: {
          test: { command: 'echo' },
        },
      }),
      {
        models: [],
        currentModelId: 'default',
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();
    expect((await runtime.mcpListTools()).map((tool) => tool.name)).toEqual(['test_tool']);
    expect(runtime.getToolRegistry().get('test_tool')).toBeDefined();

    await runtime.mcpDisconnect('test');
    expect(await runtime.mcpListTools()).toEqual([]);
    expect(runtime.getToolRegistry().get('test_tool')).toBeUndefined();

    await runtime.mcpReconnect('test');
    expect((await runtime.mcpListTools()).map((tool) => tool.name)).toEqual(['test_tool']);
    expect(runtime.getToolRegistry().get('test_tool')).toBeDefined();

    await runtime.close();
  });

  it('should project MCP server capabilities beyond flat tool registration', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-capabilities'),
      createOptions({
        mcpServers: {
          test: {
            command: 'echo',
            oauth: { enabled: true, provider: 'test-provider' },
            healthCheck: { enabled: true },
          },
        },
      }),
      {
        models: [],
        currentModelId: 'default',
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const capabilities = await runtime.mcpCapabilities();

    expect(capabilities).toEqual([
      expect.objectContaining({
        name: 'test',
        status: 'connected',
        auth: expect.objectContaining({
          enabled: true,
        }),
        tools: [
          expect.objectContaining({
            name: 'test_tool',
            description: 'A test tool',
          }),
        ],
      }),
    ]);

    await runtime.close();
  });

  it('should apply session hook callbacks to tool execution', async () => {
    const execute = vi.fn(async (params: { value?: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: params.value || 'missing',
    }));

    const runtime = new SessionRuntime(
      SessionId('session-3'),
      createOptions({
        tools: [
          {
            ...customTool,
            execute,
          },
        ],
        hooks: {
          [HookEvent.PreToolUse]: [
            async () => ({
              action: 'continue',
              modifiedInput: { value: 'from-pre-hook' },
            }),
          ],
          [HookEvent.PostToolUse]: [
            async () => ({
              action: 'continue',
              modifiedOutput: 'from-post-hook',
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const executionPipeline = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline);
    const result = await executionPipeline.execute(
      'CustomTool',
      { value: 'original' },
      {
        sessionId: SessionId('session-3'),
        contextSnapshot: createContextSnapshot(SessionId('session-3'), 'turn-1', createFilesystemContext(workspaceRoot)),
      },
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'from-pre-hook' }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
    expect(result.llmContent).toBe('from-post-hook');

    await runtime.close();
  });

  it('should combine session prompt hooks with the hook runtime facade', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-hooks'),
      createOptions({
        hooks: {
          [HookEvent.UserPromptSubmit]: [
            async () => ({
              action: 'continue',
              modifiedInput: { userPrompt: 'from-session-hook' },
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    const managerSpy = vi
      .spyOn(HookManager.getInstance(), 'executeUserPromptSubmitHooks')
      .mockResolvedValue({
        proceed: true,
        updatedPrompt: 'from-hook-manager',
        contextInjection: 'extra context',
      });

    const rewritten = await runtime.getHookRuntime().applyUserPromptSubmit('original prompt');

    expect(managerSpy).toHaveBeenCalledWith(
      'from-session-hook',
      expect.objectContaining({
        projectDir: workspaceRoot,
        sessionId: 'session-hooks',
      }),
    );
    expect(rewritten).toBe('from-hook-manager\n\nextra context');

    await runtime.close();
  });

  it('should let permission hooks modify input before canUseTool runs', async () => {
    const canUseTool = vi.fn(async (_toolName: string, input: JsonObject) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }));
    const execute = vi.fn(async (params: { value?: string }): Promise<ToolResult> => ({
      success: true,
      llmContent: params.value || 'missing',
    }));

    const runtime = new SessionRuntime(
      SessionId('session-4'),
      createOptions({
        canUseTool,
        tools: [
          {
            ...customTool,
            execute,
          },
        ],
        hooks: {
          [HookEvent.PermissionRequest]: [
            async () => ({
              action: 'continue',
              modifiedInput: { value: 'from-permission-hook' },
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const executionPipeline4 = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline4);
    const result = await executionPipeline4.execute(
      'CustomTool',
      { value: 'original' },
      {
        sessionId: SessionId('session-4'),
        contextSnapshot: createContextSnapshot(SessionId('session-4'), 'turn-1', createFilesystemContext(workspaceRoot)),
      },
    );

    expect(canUseTool).toHaveBeenCalledWith(
      'CustomTool',
      expect.objectContaining({ value: 'from-permission-hook' }),
      expect.objectContaining({ affectedPaths: [] }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'from-permission-hook' }),
      expect.anything(),
    );
    expect(result.llmContent).toBe('from-permission-hook');

    await runtime.close();
  });

  it('should apply post-tool-failure hooks to failed tool results', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-5'),
      createOptions({
        tools: [
          {
            ...customTool,
            async execute() {
              throw new Error('boom');
            },
          },
        ],
        hooks: {
          [HookEvent.PostToolUseFailure]: [
            async () => ({
              action: 'continue',
              modifiedOutput: 'hook-adjusted-error',
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    const executionPipeline5 = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline5);
    const result = await executionPipeline5.execute(
      'CustomTool',
      { value: 'original' },
      {
        sessionId: SessionId('session-5'),
        contextSnapshot: createContextSnapshot(SessionId('session-5'), 'turn-1', createFilesystemContext(workspaceRoot)),
      },
    );

    expect(result.success).toBe(false);
    expect(result.llmContent).toBe('hook-adjusted-error');

    await runtime.close();
  });
});
