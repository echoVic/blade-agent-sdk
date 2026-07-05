import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
});
