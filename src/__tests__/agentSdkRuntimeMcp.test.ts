import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeMcpModulePath = '../../packages/agent-sdk/src/session/runtimeMcp.js';
const runtimeMcpSourcePath = 'packages/agent-sdk/src/session/runtimeMcp.ts';

describe('agent-sdk package-local runtime MCP operations', () => {
  it('bundles capabilities, server operations, and tool refresh behind injected ports', async () => {
    expect(existsSync(runtimeMcpSourcePath)).toBe(true);

    const { createPackageLocalRuntimeMcpOperations } = await import(runtimeMcpModulePath);
    const localConfig = {
      server: {},
      createClientTransport: async () => ({}),
    };
    const remoteConfig = {
      command: 'node',
      args: ['server.js'],
    };
    const connectedAt = new Date('2026-07-06T00:00:00.000Z');
    const calls: unknown[] = [];
    const registry = {
      async getCapabilities() {
        calls.push(['capabilities']);
        return [
          {
            name: 'remote',
            status: 'connected',
            connectedAt,
            auth: {
              enabled: false,
            },
            health: {
              enabled: false,
              status: 'disabled',
            },
            tools: [
              {
                name: 'mcp__remote__search',
                description: 'Search docs',
                inputSchema: {},
              },
            ],
          },
        ];
      },
      registerInProcessServer(serverName: string, config: unknown) {
        calls.push(['in-process', serverName, config, this === registry]);
      },
      registerServer(serverName: string, config: unknown) {
        calls.push(['remote', serverName, config, this === registry]);
      },
      ensureServerRegistered(serverName: string, config: unknown) {
        calls.push(['ensure', serverName, config, this === registry]);
      },
      connectServer(serverName: string) {
        calls.push(['connect', serverName, this === registry]);
      },
      async getAvailableToolsByServerNames(serverNames: string[]) {
        calls.push(['available', serverNames]);
        return [
          {
            name: 'mcp__remote__search',
            tags: ['remote'],
          },
          {
            name: 'mcp__remote__write',
            tags: ['remote'],
          },
        ];
      },
    };
    const toolCatalog = {
      removeMcpTools(serverName: string) {
        calls.push(['remove', serverName]);
        return 1;
      },
      registerMcpTool(tool: { name: string }, source: unknown) {
        calls.push(['register-tool', tool.name, source]);
      },
    };

    const operations = createPackageLocalRuntimeMcpOperations({
      configuredServers: {
        local: localConfig,
        remote: remoteConfig,
      },
      mcpRegistry: registry,
      toolCatalog,
      logger: {
        warn(...args: unknown[]) {
          calls.push(['warn', args]);
        },
      },
      filterTools(tools: Array<{ name: string; tags?: readonly string[] }>) {
        calls.push(['filter', tools.map((tool) => tool.name)]);
        return tools.filter((tool) => tool.name.includes('search'));
      },
      refreshMcpTools(serverNames: string[]) {
        calls.push(['refresh', serverNames]);
      },
    });

    expect(operations.servers.config.getConfigured()).toEqual({
      local: localConfig,
      remote: remoteConfig,
    });
    await expect(operations.capabilities.getServerStatus()).resolves.toEqual([
      {
        name: 'remote',
        status: 'connected',
        toolCount: 1,
        tools: ['mcp__remote__search'],
        connectedAt,
        error: undefined,
      },
    ]);
    await operations.servers.registration.registerConfigured();
    await operations.servers.lifecycle.connect('remote');
    await operations.tools.refresh(['remote']);

    expect(calls).toEqual([
      ['capabilities'],
      ['in-process', 'local', localConfig, true],
      ['remote', 'remote', remoteConfig, true],
      ['refresh', ['local', 'remote']],
      ['ensure', 'remote', remoteConfig, true],
      ['connect', 'remote', true],
      ['refresh', ['remote']],
      ['remove', 'remote'],
      ['available', ['remote']],
      ['filter', ['mcp__remote__search', 'mcp__remote__write']],
      [
        'register-tool',
        'mcp__remote__search',
        {
          kind: 'mcp',
          trustLevel: 'remote',
          sourceId: 'remote',
        },
      ],
    ]);
  });
});
