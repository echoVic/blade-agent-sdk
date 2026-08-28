import { createHash } from 'node:crypto';
import type { Tool } from '../tools/types/tool.js';

export const MCP_TOOL_NAME_PREFIX = 'mcp__';
const MCP_SERVER_TAG_PREFIX = 'mcp-server:';

function normalizeMcpNameSegment(value: string, label: string): string {
  const canonical = value.normalize('NFKC').trim();
  if (!canonical || canonical.length > 128) {
    throw new TypeError(`${label} must contain 1 to 128 characters`);
  }
  const sanitized = canonical.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized === canonical) {
    return sanitized;
  }
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return `${sanitized.slice(0, 119)}_${digest}`;
}

export function createMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${normalizeMcpNameSegment(
    serverName,
    'MCP server name',
  )}__${normalizeMcpNameSegment(toolName, 'MCP tool name')}`;
}

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
