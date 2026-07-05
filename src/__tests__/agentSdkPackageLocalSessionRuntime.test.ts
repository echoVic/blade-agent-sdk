import { describe, expect, it, vi } from 'vitest';
import {
  isPackageLocalSdkMcpServerHandle,
  PackageLocalSessionRuntime,
  resolvePackageLocalRuntimeStorageRoot,
} from '../../packages/agent-sdk/src/session/runtimeInstance.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';
import type { BladeConfig } from '../../packages/agent-sdk/src/types/common.js';

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
});
