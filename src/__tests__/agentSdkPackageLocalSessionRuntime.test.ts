import { describe, expect, it, vi } from 'vitest';
import type { ModelPort } from '@blade-ai/ai';
import {
  isPackageLocalSdkMcpServerHandle,
  PackageLocalSessionRuntime,
  resolvePackageLocalRuntimeStorageRoot,
} from '../../packages/agent-sdk/src/session/runtimeInstance.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';
import type { TraceRecorder } from '../../packages/agent-sdk/src/observability/TraceRecorder.js';
import { HookEvent } from '../../packages/agent-sdk/src/types/constants.js';
import { PermissionMode, type BladeConfig } from '../../packages/agent-sdk/src/types/common.js';
import type { PermissionHandlerRequest } from '../../packages/agent-sdk/src/types/permissions.js';
import { ToolKind } from '../../packages/agent-sdk/src/tools/types/ToolKind.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

const bladeConfig: BladeConfig = {
  models: [],
  currentModelId: 'default',
  temperature: 0.7,
  permissions: {
    allow: [],
    deny: [],
  },
};

describe('agent-sdk package-local session runtime shell', () => {
  it('owns runtime storage root and project cwd derivation locally', () => {
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade/sessions')).toBe(
      '/workspace/.blade',
    );
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade')).toBe('/workspace/.blade');
    expect(resolvePackageLocalRuntimeStorageRoot(undefined)).toBeUndefined();

    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        storagePath: '/workspace/.blade/sessions',
      },
      bladeConfig: {
        ...bladeConfig,
        storageRoot: '/override/root',
      },
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: ['/project'],
            cwd: '/project',
          },
        },
        environment: {
          cwd: '/env-project',
        },
      },
    });

    expect(runtime.sessionId).toBe('session-1');
    expect(runtime.storageRoot).toBe('/override/root');
    expect(runtime.projectPath).toBe('/project');
    expect(runtime.hookCallbacks).toEqual({});
  });

  it('detects in-process MCP server handles without importing root MCP types', () => {
    const handle = {
      name: 'local',
      version: '1.0.0',
      server: {},
      createClientTransport: async () => ({}),
    };

    expect(isPackageLocalSdkMcpServerHandle(handle)).toBe(true);
    expect(
      isPackageLocalSdkMcpServerHandle({
        command: 'node',
        args: ['server.js'],
      }),
    ).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle(null)).toBe(false);
  });

  it('owns session create and load lifecycle through an injected store port', async () => {
    const calls: string[] = [];
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      sessionStore: {
        createSession: vi.fn(async (sessionId) => {
          calls.push(`create:${sessionId}`);
        }),
        loadSession: vi.fn(async (sessionId) => {
          calls.push(`load:${sessionId}`);
          return sessionId === 'existing-session';
        }),
        appendMessage: vi.fn(),
        forkState: vi.fn(async () => null),
        writeForkState: vi.fn(async () => null),
      },
    });

    await runtime.ensureSessionCreated();
    await runtime.ensureSessionLoaded();

    const resumedRuntime = new PackageLocalSessionRuntime({
      sessionId: 'existing-session',
      options,
      bladeConfig,
      defaultContext: {},
      sessionStore: runtime.sessionStore,
    });

    await resumedRuntime.ensureSessionLoaded();

    expect(calls).toEqual([
      'create:session-1',
      'load:session-1',
      'create:session-1',
      'load:existing-session',
    ]);
  });

  it('owns turn workspace preparation through an injected workspace port', () => {
    const updates: unknown[] = [];
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      workspace: {
        updateWorkspace(update) {
          updates.push(update);
        },
      },
    });

    runtime.prepareTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      context: {},
      filesystemRoots: ['/workspace'],
      cwd: '/workspace/project',
      environment: {
        NODE_ENV: 'test',
        cwd: '/stale',
      },
    });

    runtime.prepareTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      context: {},
      filesystemRoots: [],
      cwd: undefined,
      environment: {
        NODE_ENV: 'production',
      },
    });

    expect(updates).toEqual([
      {
        projectPath: '/workspace/project',
        environment: {
          NODE_ENV: 'test',
          cwd: '/workspace/project',
        },
      },
      {
        projectPath: undefined,
        environment: {
          NODE_ENV: 'production',
        },
      },
    ]);
  });

  it('owns close lifecycle through an injected MCP registry port', async () => {
    const disconnectAll = vi.fn(async () => {});
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll,
        getCapabilities: vi.fn(async () => []),
      },
    });

    await runtime.close();

    expect(disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('owns MCP capability projection through an injected MCP registry port', async () => {
    const connectedAt = new Date('2026-01-01T00:00:00.000Z');
    const capabilities = [
      {
        name: 'local-tools',
        status: 'connected' as const,
        connectedAt,
        auth: {
          enabled: true,
          provider: 'github',
        },
        health: {
          enabled: true,
          status: 'healthy' as const,
        },
        tools: [
          {
            name: 'search',
            description: 'Search docs',
            inputSchema: {
              type: 'object',
            },
          },
        ],
      },
    ];
    const getCapabilities = vi.fn(async () => capabilities);
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll: vi.fn(async () => {}),
        getCapabilities,
      },
    });

    await expect(runtime.mcpCapabilities()).resolves.toBe(capabilities);
    await expect(runtime.mcpServerStatus()).resolves.toEqual([
      {
        name: 'local-tools',
        status: 'connected',
        toolCount: 1,
        tools: ['search'],
        connectedAt,
        error: undefined,
      },
    ]);
    expect(getCapabilities).toHaveBeenCalledTimes(2);
  });

  it('owns MCP tool list projection through package-local capabilities', async () => {
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => [
          {
            name: 'server-a',
            status: 'connected' as const,
            auth: {
              enabled: false,
            },
            health: {
              enabled: false,
              status: 'disabled' as const,
            },
            tools: [
              {
                name: 'search',
                description: 'Search docs',
                inputSchema: {},
              },
            ],
          },
          {
            name: 'server-b',
            status: 'disconnected' as const,
            auth: {
              enabled: false,
            },
            health: {
              enabled: false,
              status: 'disabled' as const,
            },
            tools: [
              {
                name: 'read',
                description: 'Read docs',
                inputSchema: {},
              },
            ],
          },
        ]),
      },
    });

    await expect(runtime.mcpListTools()).resolves.toEqual([
      {
        name: 'search',
        description: 'Search docs',
        serverName: 'server-a',
      },
      {
        name: 'read',
        description: 'Read docs',
        serverName: 'server-b',
      },
    ]);
  });

  it('owns MCP action lifecycle through an injected MCP registry port', async () => {
    const calls: string[] = [];
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        mcpServers: {
          remote: remoteConfig,
        },
      },
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => []),
        ensureServerRegistered: vi.fn(async (serverName, config) => {
          calls.push(`ensure:${serverName}:${config === remoteConfig}`);
        }),
        connectServer: vi.fn(async (serverName) => {
          calls.push(`connect:${serverName}`);
        }),
        disconnectServer: vi.fn(async (serverName) => {
          calls.push(`disconnect:${serverName}`);
        }),
        reconnectServer: vi.fn(async (serverName) => {
          calls.push(`reconnect:${serverName}`);
        }),
        getAvailableToolsByServerNames: vi.fn(async (serverNames) => {
          calls.push(`available:${serverNames.join(',')}`);
          return [];
        }),
      },
      toolCatalog: {
        registerAll: vi.fn(),
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn((serverName) => {
          calls.push(`remove:${serverName}`);
          return 0;
        }),
      },
    });

    await runtime.mcpConnect('remote');
    await runtime.mcpDisconnect('remote');
    await runtime.mcpReconnect('remote');

    await expect(runtime.mcpConnect('missing')).rejects.toThrow(
      'MCP server "missing" not found in configuration',
    );
    expect(calls).toEqual([
      'ensure:remote:true',
      'connect:remote',
      'remove:remote',
      'available:remote',
      'disconnect:remote',
      'remove:remote',
      'available:remote',
      'ensure:remote:true',
      'reconnect:remote',
      'remove:remote',
      'available:remote',
    ]);
  });

  it('owns MCP tool refresh registration through injected registry and catalog ports', async () => {
    const calls: string[] = [];
    const readTool = {
      name: 'read',
      description: 'Read docs',
      tags: ['server-a'],
    };
    const writeTool = {
      name: 'mcp__server-b__write',
      description: 'Write docs',
      tags: [],
    };
    const searchTool = {
      name: 'search',
      description: 'Search docs',
      tags: ['server-a'],
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: ['read', 'mcp__server-b__write'],
      },
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => []),
        getAvailableToolsByServerNames: vi.fn(async (serverNames) => {
          calls.push(`available:${serverNames.join(',')}`);
          return [readTool, writeTool, searchTool];
        }),
      },
      toolCatalog: {
        registerAll: vi.fn(),
        removeMcpTools: vi.fn((serverName) => {
          calls.push(`remove:${serverName}`);
          return 1;
        }),
        registerMcpTool: vi.fn((tool, source) => {
          calls.push(`register:${tool.name}:${source.sourceId}:${source.kind}:${source.trustLevel}`);
        }),
      },
    });

    await runtime.refreshMcpTools(['server-a', 'server-b']);

    expect(calls).toEqual([
      'remove:server-a',
      'remove:server-b',
      'available:server-a,server-b',
      'register:read:server-a:mcp:remote',
      'register:mcp__server-b__write:server-b:mcp:remote',
    ]);
  });

  it('owns configured MCP server registration through an injected MCP registry port', async () => {
    const calls: string[] = [];
    const warnings: unknown[][] = [];
    const localHandle = {
      name: 'local',
      version: '1.0.0',
      server: {},
      createClientTransport: async () => ({}),
    };
    const disabledConfig = {
      command: 'node',
      args: ['disabled.js'],
      disabled: true,
    };
    const remoteConfig = {
      command: 'node',
      args: ['remote.js'],
    };
    const failingConfig = {
      command: 'node',
      args: ['failing.js'],
    };
    const failure = new Error('boom');
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        mcpServers: {
          local: localHandle,
          disabled: disabledConfig,
          remote: remoteConfig,
          failing: failingConfig,
        },
      },
      bladeConfig,
      defaultContext: {},
      mcpRegistry: {
        disconnectAll: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => []),
        registerInProcessServer: vi.fn(async (serverName, config) => {
          calls.push(`in-process:${serverName}:${config === localHandle}`);
        }),
        registerServer: vi.fn(async (serverName, config) => {
          calls.push(`remote:${serverName}:${config === remoteConfig || config === failingConfig}`);
          if (serverName === 'failing') {
            throw failure;
          }
        }),
        getAvailableToolsByServerNames: vi.fn(async (serverNames) => {
          calls.push(`available:${serverNames.join(',')}`);
          return [];
        }),
      },
      toolCatalog: {
        registerAll: vi.fn(),
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn((serverName) => {
          calls.push(`remove:${serverName}`);
          return 0;
        }),
      },
      logger: {
        warn(...args) {
          warnings.push(args);
        },
      },
    });

    await runtime.registerConfiguredMcpServers();

    expect(calls).toEqual([
      'in-process:local:true',
      'remote:remote:true',
      'remote:failing:true',
      'remove:local',
      'remove:disabled',
      'remove:remote',
      'remove:failing',
      'available:local,disabled,remote,failing',
    ]);
    expect(warnings).toEqual([
      ['[PackageLocalSessionRuntime] Failed to register MCP server failing:', failure],
    ]);
  });

  it('owns tool filtering semantics including empty allowedTools', () => {
    const tools = [
      { name: 'read' },
      { name: 'write' },
      { name: 'search' },
    ];

    const disabledRuntime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: [],
      },
      bladeConfig,
      defaultContext: {},
    });
    expect(disabledRuntime.filterTools(tools)).toEqual([]);

    const allowlistRuntime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: ['read', 'write'],
        disallowedTools: ['write'],
      },
      bladeConfig,
      defaultContext: {},
    });
    expect(allowlistRuntime.filterTools(tools)).toEqual([{ name: 'read' }]);

    const denylistRuntime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        disallowedTools: ['search'],
      },
      bladeConfig,
      defaultContext: {},
    });
    expect(denylistRuntime.filterTools(tools)).toEqual([{ name: 'read' }, { name: 'write' }]);
  });

  it('owns filtered tool registration through an injected tool catalog port', () => {
    const registerAll = vi.fn();
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: ['read', 'write'],
        disallowedTools: ['write'],
      },
      bladeConfig,
      defaultContext: {},
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
    });

    runtime.registerTools(
      [
        { name: 'read', description: 'Read files' },
        { name: 'write', description: 'Write files' },
        { name: 'search', description: 'Search files' },
      ],
      {
        kind: 'builtin',
        sourceId: 'builtin',
        trustLevel: 'trusted',
      },
    );

    expect(registerAll).toHaveBeenCalledTimes(1);
    expect(registerAll).toHaveBeenCalledWith(
      [{ name: 'read', description: 'Read files' }],
      {
        kind: 'builtin',
        sourceId: 'builtin',
        trustLevel: 'trusted',
      },
    );
  });

  it('skips tool catalog registration when filtering removes every tool', () => {
    const registerAll = vi.fn();
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: [],
      },
      bladeConfig,
      defaultContext: {},
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
    });

    runtime.registerTools(
      [
        { name: 'read', description: 'Read files' },
        { name: 'write', description: 'Write files' },
      ],
      {
        kind: 'builtin',
        sourceId: 'builtin',
        trustLevel: 'trusted',
      },
    );

    expect(registerAll).not.toHaveBeenCalled();
  });

  it('owns custom tool registration through an injected tool factory port', () => {
    const registerAll = vi.fn();
    const definitions = [
      { name: 'custom-read' },
      { name: 'custom-write' },
    ];
    const factoryCalls: unknown[] = [];
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: ['custom-read'],
        tools: definitions as NonNullable<SessionOptions['tools']>,
      },
      bladeConfig,
      defaultContext: {},
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
      customToolFactory: {
        fromDefinition(definition) {
          factoryCalls.push(definition);
          return {
            name: definition.name,
            runtimeName: `runtime:${definition.name}`,
          };
        },
      },
    });

    runtime.registerCustomTools();

    expect(factoryCalls).toEqual(definitions);
    expect(registerAll).toHaveBeenCalledTimes(1);
    expect(registerAll).toHaveBeenCalledWith(
      [{ name: 'custom-read', runtimeName: 'runtime:custom-read' }],
      {
        kind: 'custom',
        sourceId: 'session',
        trustLevel: 'workspace',
      },
    );
  });

  it('skips custom tool factory work when no custom tools are configured', () => {
    const registerAll = vi.fn();
    const fromDefinition = vi.fn();
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
      customToolFactory: {
        fromDefinition,
      },
    });

    runtime.registerCustomTools();

    expect(fromDefinition).not.toHaveBeenCalled();
    expect(registerAll).not.toHaveBeenCalled();
  });

  it('owns builtin tool registration through an injected builtin tool provider port', async () => {
    const registerAll = vi.fn();
    const providerCalls: unknown[] = [];
    const mcpRegistry = {
      disconnectAll: vi.fn(async () => {}),
      getCapabilities: vi.fn(async () => []),
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        storagePath: '/workspace/.blade/sessions',
        allowedTools: ['read', 'write'],
        disallowedTools: ['write'],
      },
      bladeConfig,
      defaultContext: {},
      mcpRegistry,
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
      builtinToolProvider: {
        async getTools(context) {
          providerCalls.push(context);
          return [
            { name: 'read', description: 'Read files' },
            { name: 'write', description: 'Write files' },
            { name: 'search', description: 'Search files' },
          ];
        },
      },
    });

    await runtime.registerBuiltinTools();

    expect(providerCalls).toEqual([
      {
        sessionId: 'session-1',
        configDir: '/workspace/.blade',
        mcpRegistry,
        includeMcpProtocolTools: false,
      },
    ]);
    expect(registerAll).toHaveBeenCalledTimes(1);
    expect(registerAll).toHaveBeenCalledWith(
      [{ name: 'read', description: 'Read files' }],
      {
        kind: 'builtin',
        sourceId: 'builtin',
        trustLevel: 'trusted',
      },
    );
  });

  it('skips builtin tool catalog registration when no builtin tools survive filtering', async () => {
    const registerAll = vi.fn();
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        allowedTools: [],
      },
      bladeConfig,
      defaultContext: {},
      toolCatalog: {
        registerAll,
        registerMcpTool: vi.fn(),
        removeMcpTools: vi.fn(() => 0),
      },
      builtinToolProvider: {
        async getTools() {
          return [{ name: 'read', description: 'Read files' }];
        },
      },
    });

    await runtime.registerBuiltinTools();

    expect(registerAll).not.toHaveBeenCalled();
  });

  it('owns subagent initialization through an injected subagent registry port', () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), child: vi.fn(() => logger) };
    const calls: unknown[] = [];
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        storagePath: '/workspace/.blade/sessions',
        agents: {
          reviewer: {
            name: 'Review',
            description: 'Review code',
            systemPrompt: 'Review safely',
            allowedTools: ['read'],
            model: 'gpt-5',
          },
          planner: {
            name: '',
            description: 'Plan work',
          },
        },
      },
      bladeConfig,
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: ['/project'],
            cwd: '/project',
          },
        },
        environment: {
          cwd: '/env-project',
        },
      },
      logger,
      subagentRegistry: {
        setLogger(input) {
          calls.push(['setLogger', input]);
        },
        setProjectDir(projectDir) {
          calls.push(['setProjectDir', projectDir]);
        },
        loadFromStandardLocations(projectDir, storageRoot) {
          calls.push(['loadFromStandardLocations', projectDir, storageRoot]);
        },
        register(config, options) {
          calls.push(['register', config, options]);
        },
      },
    });

    runtime.initializeSubagents();

    expect(calls).toEqual([
      ['setLogger', logger],
      ['setProjectDir', '/project'],
      ['loadFromStandardLocations', '/project', '/workspace/.blade'],
      [
        'register',
        {
          name: 'Review',
          description: 'Review code',
          systemPrompt: 'Review safely',
          tools: ['read'],
          model: 'gpt-5',
          source: 'session',
        },
        { override: true },
      ],
      [
        'register',
        {
          name: 'planner',
          description: 'Plan work',
          systemPrompt: undefined,
          tools: undefined,
          model: 'inherit',
          source: 'session',
        },
        { override: true },
      ],
    ]);
  });

  it('owns permission handler composition with permission hooks before canUseTool', async () => {
    const abortController = new AbortController();
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const hookCalls: unknown[] = [];
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        canUseTool,
        hooks: {
          [HookEvent.PermissionRequest]: [
            async () => ({
              action: 'continue',
              modifiedInput: { value: 'from-hook' },
            }),
          ],
        },
      },
      bladeConfig,
      defaultContext: {},
      permissionHooks: {
        async applyPermissionRequestHooks(toolName, input, options) {
          hookCalls.push([toolName, { ...input }, options]);
          return {
            updatedInput: { ...input, value: 'from-hook' },
          };
        },
      },
    });

    const handler = runtime.createPermissionHandler();
    expect(handler).toBeDefined();

    const request: PermissionHandlerRequest = {
      toolName: 'CustomTool',
      input: { value: 'original' },
      signal: abortController.signal,
      affectedPaths: ['/workspace/file.ts'],
      toolKind: ToolKind.Write,
      toolMeta: {
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: false,
      },
    };

    const result = await handler?.(request);

    expect(hookCalls).toEqual([
      [
        'CustomTool',
        { value: 'original' },
        {
          affectedPaths: ['/workspace/file.ts'],
          toolKind: ToolKind.Write,
          abortSignal: abortController.signal,
        },
      ],
    ]);
    expect(canUseTool).toHaveBeenCalledWith(
      'CustomTool',
      { value: 'from-hook' },
      {
        signal: abortController.signal,
        toolKind: ToolKind.Write,
        affectedPaths: ['/workspace/file.ts'],
      },
    );
    expect(request.input).toEqual({ value: 'from-hook' });
    expect(result).toEqual({ behavior: 'ask' });
  });

  it('owns hook manager initialization through an injected hook manager port', () => {
    const enable = vi.fn();
    const runtimeWithoutHooks = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      hookManager: { enable },
    });

    runtimeWithoutHooks.initializeHooks();
    expect(enable).not.toHaveBeenCalled();

    const runtimeWithHooks = new PackageLocalSessionRuntime({
      sessionId: 'session-2',
      options: {
        ...options,
        hooks: {
          [HookEvent.SessionStart]: [],
        },
      },
      bladeConfig,
      defaultContext: {},
      hookManager: { enable },
    });

    runtimeWithHooks.initializeHooks();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('owns execution pipeline creation through an injected factory port', () => {
    const pipeline = { id: 'pipeline' };
    const create = vi.fn((input: unknown) => {
      void input;
      return pipeline;
    });
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const toolCatalog = {
      registerAll: vi.fn(),
      registerMcpTool: vi.fn(),
      removeMcpTools: vi.fn(() => 0),
    };
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options: {
        ...options,
        permissionMode: PermissionMode.YOLO,
        permissionHandler,
      },
      bladeConfig: {
        ...bladeConfig,
        permissions: {
          allow: ['Read'],
          ask: ['Write'],
          deny: ['Bash'],
        },
      },
      defaultContext: {},
      toolCatalog,
      logger,
      executionPipelineFactory: { create },
    });

    expect(runtime.createExecutionPipeline()).toBe(pipeline);
    expect(create).toHaveBeenCalledTimes(1);
    const createOptions = create.mock.calls[0]?.[0] as
      | { permissionHandler?: unknown }
      | undefined;
    expect(createOptions).toMatchObject({
      permissionConfig: {
        allow: ['Read'],
        ask: ['Write'],
        deny: ['Bash'],
      },
      permissionMode: PermissionMode.YOLO,
      maxHistorySize: 1000,
      logger,
      toolCatalog,
    });
    expect(createOptions?.permissionHandler).toEqual(expect.any(Function));
  });

  it('projects package-local agent runtime dependencies through injected ports', () => {
    const pipeline = { id: 'pipeline' };
    const context = {
      environment: {
        cwd: '/workspace',
      },
    };
    const mcpRegistry = {
      disconnectAll: vi.fn(async () => {}),
      getCapabilities: vi.fn(async () => []),
    };
    const subagentRegistry = {
      setLogger: vi.fn(),
      setProjectDir: vi.fn(),
      loadFromStandardLocations: vi.fn(() => 0),
      register: vi.fn(),
    };
    const hookRuntime = {
      enable: vi.fn(),
      setTraceCollector: vi.fn(),
    };
    const backgroundAgentManager = {
      run: vi.fn(),
    };
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const create = vi.fn(() => pipeline);
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: context,
      mcpRegistry,
      subagentRegistry,
      hookRuntime,
      backgroundAgentManager,
      logger,
      executionPipelineFactory: { create },
    });

    expect(runtime.getAgentRuntimeDeps()).toEqual({
      executionPipeline: pipeline,
      defaultContext: context,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
      runtimeManaged: true,
      logger,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates kernel ports through an injected package-local factory', () => {
    const toolPort = {
      list: vi.fn(async () => []),
      execute: vi.fn(async (toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        output: '',
      })),
    };
    const storePort = { appendMessage: vi.fn() };
    const tracePort = { record: vi.fn() };
    const hookPort = { beforeModel: vi.fn((request) => request) };
    const pipeline = { id: 'pipeline' };
    const createPipeline = vi.fn(() => pipeline);
    const sessionStore = {
      createSession: vi.fn(async () => {}),
      loadSession: vi.fn(async () => true),
      appendMessage: vi.fn(),
      forkState: vi.fn(async () => null),
      writeForkState: vi.fn(async () => null),
    };
    const toolCatalog = {
      registerAll: vi.fn(),
      registerMcpTool: vi.fn(),
      removeMcpTools: vi.fn(() => 0),
    };
    const hookRuntime = {
      enable: vi.fn(),
      setTraceCollector: vi.fn(),
    };
    const traceRecorder = {
      startSpan: vi.fn(),
    } as unknown as TraceRecorder;
    const createExecutionContext = vi.fn(() => ({}));
    const kernelPortFactory = {
      createToolPort: vi.fn(() => toolPort),
      createStorePort: vi.fn(() => storePort),
      createTracePort: vi.fn(() => tracePort),
      createHookPort: vi.fn(() => hookPort),
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      sessionStore,
      toolCatalog,
      hookRuntime,
      executionPipelineFactory: { create: createPipeline },
      kernelPortFactory,
    });

    expect(runtime.getKernelToolPort(createExecutionContext)).toBe(toolPort);
    expect(runtime.getKernelStorePort()).toBe(storePort);
    expect(runtime.getKernelTracePort(traceRecorder, 4096)).toBe(tracePort);
    expect(runtime.getKernelHookPort()).toBe(hookPort);

    expect(kernelPortFactory.createToolPort).toHaveBeenCalledWith({
      toolCatalog,
      executionPipeline: pipeline,
      createExecutionContext,
    });
    expect(kernelPortFactory.createStorePort).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sessionStore,
    });
    expect(kernelPortFactory.createTracePort).toHaveBeenCalledWith({
      recorder: traceRecorder,
      maxContextTokens: 4096,
    });
    expect(kernelPortFactory.createHookPort).toHaveBeenCalledWith({ hookRuntime });
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it('creates an agent kernel through an injected package-local factory', () => {
    const model = createModelPort();
    const kernel = {
      id: 'kernel',
      async *runTurn() {},
    };
    const storePort = { appendMessage: vi.fn() };
    const hookPort = { beforeModel: vi.fn((request) => request) };
    const tracePort = { record: vi.fn() };
    const toolPort = {
      list: vi.fn(async () => []),
      execute: vi.fn(async (toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        output: '',
      })),
    };
    const traceRecorder = {} as TraceRecorder;
    const createExecutionContext = vi.fn(() => ({}));
    const kernelFactory = {
      create: vi.fn(() => kernel),
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      kernelFactory,
      kernelPortFactory: {
        createToolPort: vi.fn(() => toolPort),
        createStorePort: vi.fn(() => storePort),
        createTracePort: vi.fn(() => tracePort),
        createHookPort: vi.fn(() => hookPort),
      },
    });

    expect(
      runtime.createAgentKernel({
        model,
        modelRequestDefaults: {
          model: 'explicit-model',
          maxContextTokens: 32000,
          temperature: 0.2,
        },
        traceRecorder,
        createExecutionContext,
        maxSteps: 7,
      }),
    ).toBe(kernel);

    expect(kernelFactory.create).toHaveBeenCalledWith({
      model,
      modelRequestDefaults: {
        model: 'explicit-model',
        maxContextTokens: 32000,
        temperature: 0.2,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      maxSteps: 7,
    });
  });

  it('resolves the session kernel model through an injected package-local resolver', () => {
    const resolvedModel = createModelPort();
    const kernel = {
      id: 'kernel',
      async *runTurn() {},
    };
    const kernelFactory = {
      create: vi.fn(() => kernel),
    };
    const modelResolver = {
      resolve: vi.fn(() => ({
        model: resolvedModel,
        modelRequestDefaults: {
          model: 'resolved-model',
          maxContextTokens: 128000,
        },
      })),
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      kernelFactory,
      kernelModelResolver: modelResolver,
    });

    expect(runtime.createAgentKernel({ modelId: 'secondary-model' })).toBe(kernel);
    expect(modelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig,
      modelId: 'secondary-model',
    });
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: resolvedModel,
      modelRequestDefaults: {
        model: 'resolved-model',
        maxContextTokens: 128000,
      },
      store: expect.any(Object),
      hooks: expect.any(Object),
    });
  });

  it('projects agent kernel stream events into session stream messages locally', () => {
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
    });

    expect(
      runtime.projectKernelEventToStreamMessages(
        { type: 'content', delta: 'hello' },
        { maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([{ type: 'content', delta: 'hello', sessionId: 'session-1' }]);

    expect(
      runtime.projectKernelEventToStreamMessages(
        { type: 'thinking', delta: 'hidden' },
        { maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([]);

    expect(
      runtime.projectKernelEventToStreamMessages(
        { type: 'thinking', delta: 'visible' },
        { maxContextTokens: 4096, includeThinking: true },
      ),
    ).toEqual([{ type: 'thinking', delta: 'visible', sessionId: 'session-1' }]);

    expect(
      runtime.projectKernelEventToStreamMessages(
        {
          type: 'tool_permission_updates',
          toolCall: {
            id: 'call-1',
            name: 'Edit',
            input: {},
          },
          updates: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Edit', ruleContent: '/workspace/file.ts' }],
            },
            {
              type: 'removeRules',
              rules: [{ toolName: 'Bash' }],
            },
          ],
        },
        { maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      {
        type: 'tool_permission_updates',
        id: 'call-1',
        name: 'Edit',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Edit', ruleContent: '/workspace/file.ts' }],
          },
          {
            type: 'removeRules',
            rules: [{ toolName: 'Bash' }],
          },
        ],
        sessionId: 'session-1',
      },
    ]);

    expect(
      runtime.projectKernelEventToStreamMessages(
        {
          type: 'usage',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            reasoningTokens: 2,
            cacheReadInputTokens: 3,
            cacheMissInputTokens: 4,
            billableInputTokens: 11,
          },
        },
        { maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          maxContextTokens: 4096,
          reasoningTokens: 2,
          cacheReadInputTokens: 3,
          cacheMissInputTokens: 4,
          billableInputTokens: 11,
        },
        sessionId: 'session-1',
      },
    ]);

    expect(
      runtime.projectKernelEventToStreamMessages(
        { type: 'result', content: 'done' },
        { maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'session-1' },
    ]);
  });

  it('streams agent kernel turns through package-local stream projection', async () => {
    const signal = new AbortController().signal;
    const model = createModelPort();
    const runTurns: unknown[] = [];
    const kernel = {
      async *runTurn(turn: unknown) {
        runTurns.push(turn);
        yield { type: 'content' as const, delta: 'hello' };
        yield { type: 'thinking' as const, delta: 'thought' };
        yield {
          type: 'usage' as const,
          usage: {
            promptTokens: 4,
            completionTokens: 6,
            totalTokens: 10,
          },
        };
        yield { type: 'result' as const, content: 'done' };
      },
    };
    const kernelFactory = {
      create: vi.fn(() => kernel),
    };
    const runtime = new PackageLocalSessionRuntime({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext: {},
      kernelFactory,
    });

    const messages = [];
    for await (const message of runtime.streamAgentKernelTurn({
      input: 'hi',
      turnId: 'turn-1',
      signal,
      model,
      modelRequestDefaults: {
        model: 'explicit-model',
        maxContextTokens: 8192,
      },
      includeThinking: true,
      maxSteps: 3,
    })) {
      messages.push(message);
    }

    expect(runTurns).toEqual([
      {
        input: 'hi',
        turnId: 'turn-1',
        signal,
      },
    ]);
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model,
      modelRequestDefaults: {
        model: 'explicit-model',
        maxContextTokens: 8192,
      },
      store: expect.any(Object),
      hooks: expect.any(Object),
      maxSteps: 3,
    });
    expect(messages).toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'session-1' },
      { type: 'content', delta: 'hello', sessionId: 'session-1' },
      { type: 'thinking', delta: 'thought', sessionId: 'session-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
          maxContextTokens: 8192,
        },
        sessionId: 'session-1',
      },
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'session-1' },
    ]);
  });
});

function createModelPort(): ModelPort {
  return {
    async generate() {
      return { content: '' };
    },
    async *stream() {},
  };
}
