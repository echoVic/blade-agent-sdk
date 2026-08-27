import type { Tool } from '../tools/types/tool.js';

const MCP_SERVER_TAG_PREFIX = 'mcp-server:';

export function createMcpServerTag(serverName: string): string {
  return `${MCP_SERVER_TAG_PREFIX}${serverName}`;
}

export function resolveMcpServerName(tool: Pick<Tool, 'name' | 'tags'>): string {
  const taggedServer = tool.tags
    .find(
      (tag) => tag.startsWith(MCP_SERVER_TAG_PREFIX) && tag.length > MCP_SERVER_TAG_PREFIX.length,
    )
    ?.slice(MCP_SERVER_TAG_PREFIX.length);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__(.+?)__/);
  return match?.[1] ?? 'mcp';
}
