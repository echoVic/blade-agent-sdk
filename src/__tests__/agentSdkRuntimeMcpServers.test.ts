import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const mcpServersModulePath = '../../packages/agent-sdk/src/session/runtimeMcpServers.js';
const mcpServersSourcePath = 'packages/agent-sdk/src/session/runtimeMcpServers.ts';

describe('agent-sdk package-local runtime MCP server helpers', () => {
  it('detects in-process MCP server handles without session runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { isPackageLocalSdkMcpServerHandle } = await import(mcpServersModulePath);

    expect(
      isPackageLocalSdkMcpServerHandle({
        name: 'local',
        version: '1.0.0',
        server: {},
        createClientTransport: async () => ({}),
      }),
    ).toBe(true);

    expect(
      isPackageLocalSdkMcpServerHandle({
        command: 'node',
        args: ['server.js'],
      }),
    ).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle(null)).toBe(false);
    expect(isPackageLocalSdkMcpServerHandle({ server: {} })).toBe(false);
  });

  it('invokes MCP registry actions with controlled capability errors', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const {
      callPackageLocalMcpRegistryAction,
      registerPackageLocalInProcessMcpServer,
      registerPackageLocalRemoteMcpServer,
    } = await import(mcpServersModulePath);

    const calls: unknown[] = [];
    const registry = {
      connectServer(serverName: string) {
        calls.push(['connect', serverName, this === registry]);
      },
      registerInProcessServer(serverName: string, config: unknown) {
        calls.push(['in-process', serverName, config, this === registry]);
      },
      registerServer(serverName: string, config: unknown) {
        calls.push(['remote', serverName, config, this === registry]);
      },
    };
    const inProcessConfig = {
      server: {},
      createClientTransport: async () => ({}),
    };
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };

    await callPackageLocalMcpRegistryAction(registry, 'connectServer', 'local');
    await registerPackageLocalInProcessMcpServer(registry, 'local', inProcessConfig);
    await registerPackageLocalRemoteMcpServer(registry, 'remote', remoteConfig);

    expect(calls).toEqual([
      ['connect', 'local', true],
      ['in-process', 'local', inProcessConfig, true],
      ['remote', 'remote', remoteConfig, true],
    ]);

    await expect(
      callPackageLocalMcpRegistryAction({}, 'disconnectServer', 'missing'),
    ).rejects.toThrow('Package-local MCP registry port does not implement disconnectServer');
    await expect(registerPackageLocalInProcessMcpServer({}, 'local', inProcessConfig)).rejects.toThrow(
      'Package-local MCP registry port does not implement registerInProcessServer',
    );
    await expect(registerPackageLocalRemoteMcpServer({}, 'remote', remoteConfig)).rejects.toThrow(
      'Package-local MCP registry port does not implement registerServer',
    );
  });

  it('registers configured MCP servers and refreshes configured tool names without runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { registerPackageLocalConfiguredMcpServers } = await import(mcpServersModulePath);
    const calls: unknown[] = [];
    const warnings: unknown[][] = [];
    const localConfig = {
      server: {},
      createClientTransport: async () => ({}),
    };
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const failingRemoteConfig = {
      command: 'node',
      args: ['missing.js'],
    };

    await registerPackageLocalConfiguredMcpServers({
      configuredServers: {
        local: localConfig,
        remote: remoteConfig,
        disabled: {
          command: 'node',
          args: ['disabled.js'],
          disabled: true,
        },
        failing: failingRemoteConfig,
      },
      mcpRegistry: {
        registerInProcessServer(serverName: string, config: unknown) {
          calls.push(['in-process', serverName, config]);
        },
        registerServer(serverName: string, config: unknown) {
          calls.push(['remote', serverName, config]);
          if (serverName === 'failing') {
            throw new Error('remote failed');
          }
        },
      },
      logger: {
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      },
      refreshMcpTools(serverNames: string[]) {
        calls.push(['refresh', serverNames]);
      },
    });

    expect(calls).toEqual([
      ['in-process', 'local', localConfig],
      ['remote', 'remote', remoteConfig],
      ['remote', 'failing', failingRemoteConfig],
      ['refresh', ['local', 'remote', 'disabled', 'failing']],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toBe(
      '[PackageLocalSessionRuntime] Failed to register MCP server failing:',
    );
    expect(warnings[0][1]).toBeInstanceOf(Error);
  });

  it('bundles configured MCP server registration behind injected ports', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { createPackageLocalRuntimeMcpServerRegistrationOperations } = await import(
      mcpServersModulePath
    );
    const calls: unknown[] = [];
    const localConfig = {
      server: {},
      createClientTransport: async () => ({}),
    };
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const registry = {
      registerInProcessServer(serverName: string, config: unknown) {
        calls.push(['in-process', serverName, config, this === registry]);
      },
      registerServer(serverName: string, config: unknown) {
        calls.push(['remote', serverName, config, this === registry]);
      },
    };

    const operations = createPackageLocalRuntimeMcpServerRegistrationOperations({
      configuredServers: {
        local: localConfig,
        remote: remoteConfig,
      },
      mcpRegistry: registry,
      logger: {
        warn(...args: unknown[]) {
          calls.push(['warn', args]);
        },
      },
      refreshMcpTools(serverNames: string[]) {
        calls.push(['refresh', serverNames]);
      },
    });

    await operations.registerConfigured();

    expect(calls).toEqual([
      ['in-process', 'local', localConfig, true],
      ['remote', 'remote', remoteConfig, true],
      ['refresh', ['local', 'remote']],
    ]);
  });

  it('ensures configured MCP servers through registry ports without runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { ensurePackageLocalMcpServerRegistered } = await import(mcpServersModulePath);
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const calls: unknown[] = [];
    const registry = {
      ensureServerRegistered(serverName: string, config: unknown) {
        calls.push([serverName, config, this === registry]);
      },
    };

    await ensurePackageLocalMcpServerRegistered({
      serverName: 'remote',
      configuredServers: {
        remote: remoteConfig,
      },
      mcpRegistry: registry,
    });

    expect(calls).toEqual([['remote', remoteConfig, true]]);
    await expect(
      ensurePackageLocalMcpServerRegistered({
        serverName: 'missing',
        configuredServers: {
          remote: remoteConfig,
        },
        mcpRegistry: registry,
      }),
    ).rejects.toThrow('MCP server "missing" not found in configuration');
  });

  it('runs MCP server lifecycle actions and refreshes tools without runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(mcpServersSourcePath, 'utf-8'),
    );
    expect(source).toContain('connectPackageLocalRuntimeMcpServer');
    expect(source).toContain('disconnectPackageLocalRuntimeMcpServer');
    expect(source).toContain('reconnectPackageLocalRuntimeMcpServer');

    const {
      connectPackageLocalRuntimeMcpServer,
      disconnectPackageLocalRuntimeMcpServer,
      reconnectPackageLocalRuntimeMcpServer,
    } = await import(mcpServersModulePath);
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const calls: unknown[] = [];
    const registry = {
      ensureServerRegistered(serverName: string, config: unknown) {
        calls.push(['ensure', serverName, config, this === registry]);
      },
      connectServer(serverName: string) {
        calls.push(['connect', serverName, this === registry]);
      },
      disconnectServer(serverName: string) {
        calls.push(['disconnect', serverName, this === registry]);
      },
      disconnectAll() {
        calls.push(['disconnect-all', this === registry]);
      },
      reconnectServer(serverName: string) {
        calls.push(['reconnect', serverName, this === registry]);
      },
    };
    const refreshMcpTools = async (serverNames: string[]) => {
      calls.push(['refresh', serverNames]);
    };

    await connectPackageLocalRuntimeMcpServer({
      serverName: 'remote',
      configuredServers: {
        remote: remoteConfig,
      },
      mcpRegistry: registry,
      refreshMcpTools,
    });
    await disconnectPackageLocalRuntimeMcpServer({
      serverName: 'remote',
      mcpRegistry: registry,
      refreshMcpTools,
    });
    await reconnectPackageLocalRuntimeMcpServer({
      serverName: 'remote',
      configuredServers: {
        remote: remoteConfig,
      },
      mcpRegistry: registry,
      refreshMcpTools,
    });

    expect(calls).toEqual([
      ['ensure', 'remote', remoteConfig, true],
      ['connect', 'remote', true],
      ['refresh', ['remote']],
      ['disconnect', 'remote', true],
      ['refresh', ['remote']],
      ['ensure', 'remote', remoteConfig, true],
      ['reconnect', 'remote', true],
      ['refresh', ['remote']],
    ]);
  });

  it('bundles MCP server lifecycle operations behind injected ports', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { createPackageLocalRuntimeMcpServerLifecycleOperations } = await import(
      mcpServersModulePath
    );
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const calls: unknown[] = [];
    const registry = {
      ensureServerRegistered(serverName: string, config: unknown) {
        calls.push(['ensure', serverName, config, this === registry]);
      },
      connectServer(serverName: string) {
        calls.push(['connect', serverName, this === registry]);
      },
      disconnectServer(serverName: string) {
        calls.push(['disconnect', serverName, this === registry]);
      },
      disconnectAll() {
        calls.push(['disconnect-all', this === registry]);
      },
      reconnectServer(serverName: string) {
        calls.push(['reconnect', serverName, this === registry]);
      },
    };

    const operations = createPackageLocalRuntimeMcpServerLifecycleOperations({
      configuredServers: {
        remote: remoteConfig,
      },
      mcpRegistry: registry,
      refreshMcpTools(serverNames: string[]) {
        calls.push(['refresh', serverNames]);
      },
    });

    await operations.connect('remote');
    await operations.disconnect('remote');
    await operations.reconnect('remote');
    await operations.close();

    expect(calls).toEqual([
      ['ensure', 'remote', remoteConfig, true],
      ['connect', 'remote', true],
      ['refresh', ['remote']],
      ['disconnect', 'remote', true],
      ['refresh', ['remote']],
      ['ensure', 'remote', remoteConfig, true],
      ['reconnect', 'remote', true],
      ['refresh', ['remote']],
      ['disconnect-all', true],
    ]);
  });

  it('closes all MCP servers through the registry port without runtime state', async () => {
    expect(existsSync(mcpServersSourcePath)).toBe(true);

    const { closePackageLocalRuntimeMcpServers } = await import(mcpServersModulePath);
    const registry = {
      disconnectAll: vi.fn(async function disconnectAll(this: unknown) {
        expect(this).toBe(registry);
      }),
    };

    await closePackageLocalRuntimeMcpServers({ mcpRegistry: registry });

    expect(registry.disconnectAll).toHaveBeenCalledOnce();
  });
});
