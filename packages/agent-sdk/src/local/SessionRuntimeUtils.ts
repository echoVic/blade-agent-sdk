import type { Tool } from '../tools/types/index.js';

/**
 * Extracts the MCP server name from a tool instance.
 * Uses the first lowercase tag as the server name, or parses
 * it from the tool name pattern `mcp__<server>__<rest>`.
 */
export function serverNameFromTool(tool: Tool): string {
  const taggedServer = tool.tags.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}
