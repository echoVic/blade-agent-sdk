import { createHash } from 'node:crypto';

export const MCP_TOOL_NAME_PREFIX = 'mcp__';

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
