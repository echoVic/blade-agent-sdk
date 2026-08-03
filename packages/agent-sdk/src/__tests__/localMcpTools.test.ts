import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import {
  createListMcpResourcesTool,
  createReadMcpResourceTool,
} from '../local/mcp-tools/index.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local MCP tools', () => {
  it('does not include MCP tools in default builtin tools', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('ListMcpResources');
    expect(names).not.toContain('ReadMcpResource');
  });

  it('includes MCP tools when includeMcpProtocolTools and mcpRegistry are provided', async () => {
    const mockRegistry = {
      getAllServers: () => [],
      getServer: () => undefined,
    };
    const tools = await getBuiltinTools({
      includeMcpProtocolTools: true,
      mcpRegistry: mockRegistry,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('ListMcpResources');
    expect(names).toContain('ReadMcpResource');
  });

  it('creates a ListMcpResources tool via factory', () => {
    const tool = createListMcpResourcesTool({
      getAllServers: () => [],
      getServer: () => undefined,
    });
    expect(tool.name).toBe('ListMcpResources');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('creates a ReadMcpResource tool via factory', () => {
    const tool = createReadMcpResourceTool({
      getAllServers: () => [],
      getServer: () => undefined,
    });
    expect(tool.name).toBe('ReadMcpResource');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('ListMcpResources returns empty result with no servers', async () => {
    const tool = createListMcpResourcesTool({
      getAllServers: () => [],
      getServer: () => undefined,
    });
    const invocation = tool.build({});
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      {},
    );
    expect(result.success).toBe(true);
    expect(String(result.llmContent)).toContain('No MCP servers');
  });

  it('ReadMcpResource returns error with no servers', async () => {
    const tool = createReadMcpResourceTool({
      getAllServers: () => [],
      getServer: () => undefined,
    });
    const invocation = tool.build({ uri: 'file:///test' });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('No MCP servers');
  });
});
