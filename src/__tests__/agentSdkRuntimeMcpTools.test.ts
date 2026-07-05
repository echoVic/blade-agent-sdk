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
});
