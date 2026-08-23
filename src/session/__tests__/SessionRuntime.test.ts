import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertDefined } from '../../__tests__/helpers/assertDefined.js';
import { HookManager } from '../../hooks/HookManager.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { createContextSnapshot, type RuntimeContext } from '../../runtime/index.js';
import { getSandboxExecutor, SandboxExecutor } from '../../sandbox/SandboxExecutor.js';
import { SandboxService } from '../../sandbox/SandboxService.js';
import { FileAccessTracker } from '../../tools/builtin/file/FileAccessTracker.js';
import { createMemoryReadTool } from '../../tools/builtin/memory/index.js';
import { createTool } from '../../tools/core/createTool.js';
import { FileLockManager } from '../../tools/execution/FileLockManager.js';
import {
  collectToolExecution,
  completeToolExecution,
  type ToolDefinition,
  ToolKind,
} from '../../tools/types/index.js';
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
  sideEffect: 'pure',
  description: 'Custom test tool',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
  },
  execute() {
    return completeToolExecution({
      status: 'success',
      model: 'ok',
    });
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
    FileAccessTracker.resetInstance();
    FileLockManager.resetInstance();
    SandboxExecutor.resetInstance();
    SandboxService.resetInstance();
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
    SandboxExecutor.resetInstance();
    SandboxService.resetInstance();
  });

  it('should fail initialization when sandbox is enabled but unavailable', async () => {
    const executor = getSandboxExecutor();
    vi.spyOn(executor, 'getCapabilities').mockReturnValue({
      available: false,
      type: 'none',
      features: {
        fileSystemIsolation: false,
        networkIsolation: false,
        processIsolation: false,
      },
    });
    const runtime = new SessionRuntime(
      SessionId('session-sandbox-unavailable'),
      createOptions({
        sandbox: { enabled: true },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await expect(runtime.initialize()).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      name: 'ConfigError',
    });

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

  it('applies the Session tool timeout to runtime tool execution', async () => {
    let observedAbort = false;
    const slowTool = createTool({
      name: 'SlowTool',
      displayName: 'Slow Tool',
      kind: ToolKind.Execute,
      sideEffect: 'non_idempotent',
      description: { short: 'Wait until cancelled' },
      schema: z.object({}),
      async *execute(_params, context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(context.signal?.reason);
            },
            { once: true },
          );
        });
        return {
          status: 'success',
          model: 'unexpected',
        };
      },
    });
    const runtime = new SessionRuntime(
      SessionId('session-tool-timeout'),
      createOptions({
        allowedTools: ['SlowTool'],
        tools: [slowTool],
        toolTimeoutMs: 10,
      }),
      {
        models: [],
        toolTimeoutMs: 10,
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();
    const executionPipeline = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline);
    const result = await collectToolExecution(
      executionPipeline.execute('SlowTool', {}, {}),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: { type: 'timeout_error' },
    });
    expect(observedAbort).toBe(true);

    await runtime.close();
  });

  it('should install plugin tools and tool middleware through one declarative entry', async () => {
    const calls: string[] = [];
    const pluginTool = createTool({
      name: 'PluginTool',
      displayName: 'Plugin Tool',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      description: { short: 'Plugin test tool' },
      schema: z.object({ value: z.string().optional() }),
      execute(params) {
        return completeToolExecution({
          status: 'success',
          model: params.value ?? 'missing',
        });
      },
    });
    const runtime = new SessionRuntime(
      SessionId('session-plugin'),
      createOptions({
        allowedTools: ['PluginTool'],
        plugins: [
          {
            name: 'audit',
            tools: [pluginTool],
            middleware: {
              tool: [
                async function* (request, next) {
                  calls.push(`before:${request.toolName}`);
                  const result = yield* next({
                    ...request,
                    input: { ...request.input, value: 'from-plugin' },
                  });
                  calls.push(`after:${request.toolName}`);
                  return result;
                },
              ],
            },
          },
        ],
      }),
      {
        models: [],
      },
      PermissionMode.YOLO,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    expect(runtime.getToolCatalog().getEntry('PluginTool')).toMatchObject({
      source: {
        kind: 'custom',
        trustLevel: 'workspace',
        sourceId: 'plugin:audit',
      },
    });
    expect(
      runtime.getBackgroundAgentManager().getMiddleware().tool,
    ).toHaveLength(1);
    const executionPipeline = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline);
    const result = await collectToolExecution(
      executionPipeline.execute('PluginTool', { value: 'original' }, {}),
    );

    expect(result).toMatchObject({
      status: 'success',
      model: 'from-plugin',
    });
    expect(calls).toEqual(['before:PluginTool', 'after:PluginTool']);

    await runtime.close();
  });

  it('rejects duplicate plugin tool names without replacing prior registrations', async () => {
    const cases: Array<{
      label: string;
      toolName: string;
      expectedSourceId: string;
      options: Partial<SessionOptions>;
    }> = [
      {
        label: 'builtin conflict',
        toolName: 'Read',
        expectedSourceId: 'builtin',
        options: {
          allowedTools: ['Read'],
          plugins: [
            {
              name: 'duplicate-builtin',
              tools: [{ ...customTool, name: 'Read' }],
            },
          ],
        },
      },
      {
        label: 'session tool conflict',
        toolName: 'CustomTool',
        expectedSourceId: 'session',
        options: {
          allowedTools: ['CustomTool'],
          tools: [customTool],
          plugins: [
            {
              name: 'duplicate-session',
              tools: [customTool],
            },
          ],
        },
      },
      {
        label: 'plugin conflict',
        toolName: 'CustomTool',
        expectedSourceId: 'plugin:first-plugin',
        options: {
          allowedTools: ['CustomTool'],
          plugins: [
            {
              name: 'first-plugin',
              tools: [customTool],
            },
            {
              name: 'second-plugin',
              tools: [customTool],
            },
          ],
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const runtime = new SessionRuntime(
        SessionId(`session-plugin-conflict-${index}`),
        createOptions(testCase.options),
        {
          models: [],
        },
        PermissionMode.DEFAULT,
        createFilesystemContext(workspaceRoot),
        NOOP_LOGGER,
      );

      try {
        await expect(
          runtime.initialize(),
          testCase.label,
        ).rejects.toThrow('已注册');
        expect(
          runtime.getToolCatalog().getEntry(testCase.toolName)?.source.sourceId,
          testCase.label,
        ).toBe(testCase.expectedSourceId);
      } finally {
        await runtime.close();
      }
    }
  });

  it('should activate and execute hooks contributed only by a plugin', async () => {
    const enableHooks = vi.spyOn(HookManager.getInstance(), 'enable');
    const pluginHook = vi.fn(async () => ({
      action: 'continue' as const,
      modifiedInput: {
        userPrompt: 'modified by plugin',
      },
    }));
    const runtime = new SessionRuntime(
      SessionId('session-plugin-hooks'),
      createOptions({
        plugins: [
          {
            name: 'prompt-hooks',
            hooks: {
              [HookEvent.UserPromptSubmit]: [pluginHook],
            },
          },
        ],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    await expect(
      runtime.getHookRuntime().applyUserPromptSubmit('original'),
    ).resolves.toBe('modified by plugin');
    expect(enableHooks).toHaveBeenCalled();
    expect(pluginHook).toHaveBeenCalledOnce();

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

  it('should register complete Tool instances without adapting away their behavior', async () => {
    const execute = vi.fn(({ value }: { value: string }) =>
      completeToolExecution({
        status: 'success',
        model: value,
      }));
    const runtimeTool = createTool({
      name: 'RuntimeTool',
      displayName: 'Runtime Tool',
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
      strict: true,
      schema: z.object({
        value: z.string(),
      }),
      description: {
        short: 'Runtime tool',
      },
      execute,
    });
    const memoryManager = new MemoryManager({
      save: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    });
    const memoryTool = createMemoryReadTool({ manager: memoryManager });
    const runtime = new SessionRuntime(
      SessionId('session-complete-tools'),
      createOptions({
        allowedTools: ['RuntimeTool', 'MemoryRead'],
        tools: [runtimeTool, memoryTool],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );

    await runtime.initialize();

    expect(runtime.getToolRegistry().get('RuntimeTool')).toBe(runtimeTool);
    expect(runtime.getToolRegistry().get('MemoryRead')).toBe(memoryTool);
    expect(runtime.getToolRegistry().get('RuntimeTool')?.interruptBehavior).toBe('cancel');

    const executionPipeline = runtime.getAgentRuntimeDeps().executionPipeline;
    assertDefined(executionPipeline);
    const invalidResult = await collectToolExecution(
      executionPipeline.execute('RuntimeTool', {}, {}),
    );
    expect(invalidResult.status).toBe('error');
    expect(execute).not.toHaveBeenCalled();

    const validResult = await collectToolExecution(
      executionPipeline.execute('RuntimeTool', { value: 'validated' }, {}),
    );
    expect(validResult).toMatchObject({
      status: 'success',
      model: 'validated',
    });
    expect(execute).toHaveBeenCalledOnce();

    const memoryResult = await collectToolExecution(
      executionPipeline.execute('MemoryRead', { operation: 'list' }, {}),
    );
    expect(memoryResult).toMatchObject({
      status: 'success',
      model: [],
    });

    await runtime.close();
  });

  it('should not initialize file facilities before a file operation runs', async () => {
    const accessTrackerSpy = vi.spyOn(FileAccessTracker, 'getInstance');
    const lockManagerSpy = vi.spyOn(FileLockManager, 'getInstance');
    const runtime = new SessionRuntime(
      SessionId('session-no-file-tools'),
      createOptions({
        allowedTools: [],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      {},
      NOOP_LOGGER,
    );

    await runtime.initialize();

    expect(accessTrackerSpy).not.toHaveBeenCalled();
    expect(lockManagerSpy).not.toHaveBeenCalled();

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
    const execute = vi.fn((params: { value?: string }) =>
      completeToolExecution({
        status: 'success' as const,
        model: params.value || 'missing',
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
    const result = await collectToolExecution(
      executionPipeline.execute(
        'CustomTool',
        { value: 'original' },
        {
          sessionId: SessionId('session-3'),
          contextSnapshot: createContextSnapshot(SessionId('session-3'), 'turn-1', createFilesystemContext(workspaceRoot)),
        },
      ),
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'from-pre-hook' }),
      expect.anything(),
    );
    expect(result.status).toBe('success');
    expect(result.model).toBe('from-post-hook');

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
    const execute = vi.fn((params: { value?: string }) =>
      completeToolExecution({
        status: 'success' as const,
        model: params.value || 'missing',
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
    const result = await collectToolExecution(
      executionPipeline4.execute(
        'CustomTool',
        { value: 'original' },
        {
          sessionId: SessionId('session-4'),
          contextSnapshot: createContextSnapshot(SessionId('session-4'), 'turn-1', createFilesystemContext(workspaceRoot)),
        },
      ),
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
    expect(result.model).toBe('from-permission-hook');

    await runtime.close();
  });

  it('should apply post-tool-failure hooks to failed tool results', async () => {
    const runtime = new SessionRuntime(
      SessionId('session-5'),
      createOptions({
        tools: [
          {
            ...customTool,
            // biome-ignore lint/correctness/useYield: exercises a terminal execution failure
            async *execute() {
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
    const result = await collectToolExecution(
      executionPipeline5.execute(
        'CustomTool',
        { value: 'original' },
        {
          sessionId: SessionId('session-5'),
          contextSnapshot: createContextSnapshot(SessionId('session-5'), 'turn-1', createFilesystemContext(workspaceRoot)),
        },
      ),
    );

    expect(result.status).toBe('error');
    expect(result.model).toBe('hook-adjusted-error');

    await runtime.close();
  });
});
