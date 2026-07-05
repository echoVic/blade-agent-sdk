import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mcpToolsModulePath = '../../packages/agent-sdk/src/session/runtimeMcpTools.js';
const mcpToolsSourcePath = 'packages/agent-sdk/src/session/runtimeMcpTools.ts';

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
});
