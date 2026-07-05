import type { PackageLocalRuntimeMcpTool } from './runtimeInstance.js';

export function getPackageLocalMcpToolSourceId(tool: PackageLocalRuntimeMcpTool): string {
  const taggedServer = tool.tags?.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}
