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

import type { AgentPermissionUpdate } from '@blade-ai/agent/protocol';
import type { PermissionUpdate } from '../types/permissions.js';

/**
 * Converts agent-level permission updates to session-level permission updates.
 */
export function toSessionPermissionUpdates(updates: readonly AgentPermissionUpdate[]): PermissionUpdate[] {
  return updates.map((update) => {
    const rules = update.rules.map((rule) => ({
      toolName: rule.toolName,
      ...(rule.ruleContent !== undefined ? { ruleContent: rule.ruleContent } : {}),
    }));

    return update.type === 'addRules'
      ? {
          type: 'addRules' as const,
          behavior: update.behavior,
          rules,
        }
      : {
          type: 'removeRules' as const,
          rules,
        };
  });
}
