import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mcpToolsModulePath = '../session/runtimeMcpTools.js';
const mcpToolsSourcePath = 'src/session/runtimeMcpTools.ts';

describe('agent-sdk package-local runtime MCP tool helpers', () => {
  it('resolves MCP tool source ids without session runtime state', async () => {
    expect(existsSync(mcpToolsSourcePath)).toBe(true);

    const { getPackageLocalMcpToolSourceId } = await import(mcpToolsModulePath);

    expect(
      getPackageLocalMcpToolSourceId({
        name: 'mcp__filesystem__read_file',
        tags: ['filesystem'],
      }),
    ).toBe('filesystem');
    expect(
      getPackageLocalMcpToolSourceId({
        name: 'mcp__github__list_issues',
        tags: ['GitHub'],
      }),
    ).toBe('github');
    expect(
      getPackageLocalMcpToolSourceId({
        name: 'plain_tool',
        tags: [],
      }),
    ).toBe('mcp');
  });

  it('refreshes MCP tools through registry and catalog ports without runtime state', async () => {
    const { refreshPackageLocalRuntimeMcpTools } = await import(mcpToolsModulePath);
    const removedServers: string[] = [];
    const registeredTools: Array<{
      toolName: string;
      source: {
        kind: string;
        trustLevel: string;
        sourceId: string;
      };
    }> = [];

    await refreshPackageLocalRuntimeMcpTools({
      serverNames: ['filesystem', 'github'],
      mcpRegistry: {
        async getAvailableToolsByServerNames(serverNames: string[]) {
          expect(serverNames).toEqual(['filesystem', 'github']);
          return [
            {
              name: 'mcp__filesystem__read_file',
              tags: ['filesystem'],
            },
            {
              name: 'mcp__github__list_issues',
              tags: ['GitHub'],
            },
          ];
        },
      },
      toolCatalog: {
        removeMcpTools(serverName: string) {
          removedServers.push(serverName);
          return 1;
        },
        registerMcpTool(tool: { name: string }, source: {
          kind: string;
          trustLevel: string;
          sourceId: string;
        }) {
          registeredTools.push({
            toolName: tool.name,
            source,
          });
        },
      },
      filterTools(tools: Array<{ name: string; tags?: readonly string[] }>) {
        return tools.filter((tool) => tool.name.includes('github'));
      },
    });

    expect(removedServers).toEqual(['filesystem', 'github']);
    expect(registeredTools).toEqual([
      {
        toolName: 'mcp__github__list_issues',
        source: {
          kind: 'mcp',
          trustLevel: 'remote',
          sourceId: 'github',
        },
      },
    ]);
  });

  it('bundles MCP tool refresh behind injected ports', async () => {
    const { createPackageLocalRuntimeMcpToolRefreshOperations } = await import(
      mcpToolsModulePath
    );
    const calls: unknown[] = [];

    const operations = createPackageLocalRuntimeMcpToolRefreshOperations({
      mcpRegistry: {
        async getAvailableToolsByServerNames(serverNames: string[]) {
          calls.push(['available', serverNames]);
          return [
            {
              name: 'mcp__filesystem__read_file',
              tags: ['filesystem'],
            },
            {
              name: 'mcp__github__list_issues',
              tags: ['GitHub'],
            },
          ];
        },
      },
      toolCatalog: {
        removeMcpTools(serverName: string) {
          calls.push(['remove', serverName]);
          return 1;
        },
        registerMcpTool(tool: { name: string }, source: {
          kind: string;
          trustLevel: string;
          sourceId: string;
        }) {
          calls.push(['register', tool.name, source]);
        },
      },
      filterTools(tools: Array<{ name: string; tags?: readonly string[] }>) {
        calls.push(['filter', tools.map((tool) => tool.name)]);
        return tools.filter((tool) => tool.name.includes('github'));
      },
    });

    await operations.refresh(['filesystem', 'github']);

    expect(calls).toEqual([
      ['remove', 'filesystem'],
      ['remove', 'github'],
      ['available', ['filesystem', 'github']],
      ['filter', ['mcp__filesystem__read_file', 'mcp__github__list_issues']],
      [
        'register',
        'mcp__github__list_issues',
        {
          kind: 'mcp',
          trustLevel: 'remote',
          sourceId: 'github',
        },
      ],
    ]);
  });
});
