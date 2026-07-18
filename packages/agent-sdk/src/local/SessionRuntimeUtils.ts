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
import { basename, dirname } from 'node:path';

/**
 * Resolves a storage root path from a storage path.
 * If the storage path ends with 'sessions', returns the parent directory.
 */
export function resolveStorageRoot(storagePath?: string): string | undefined {
  if (!storagePath) {
    return undefined;
  }

  return basename(storagePath) === 'sessions'
    ? dirname(storagePath)
    : storagePath;
}

import type { AgentDefinition } from './sessionTypes.js';

/**
 * Converts an AgentDefinition to a subagent configuration object.
 */
export function toSubagentConfig(name: string, definition: AgentDefinition) {
  return {
    name: definition.name || name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.allowedTools,
    model: definition.model ?? 'inherit',
    source: 'session' as const,
  };
}

import type { McpServerConfig } from '../types/common.js';
import type { SdkMcpServerHandle } from './SdkMcpServer.js';

/**
 * Type guard: checks if an MCP server config is a local SDK server handle.
 */
export function isSdkMcpServerHandle(
  config: McpServerConfig | SdkMcpServerHandle
): config is SdkMcpServerHandle {
  return 'createClientTransport' in config && 'server' in config;
}

import type { AgentStreamEvent } from '@blade-ai/agent/protocol';
import type { TokenUsage } from '../core/index.js';

/**
 * Converts a usage event from the agent stream into a typed TokenUsage object.
 */
export function toSessionUsage(
  usage: Extract<AgentStreamEvent, { type: 'usage' }>['usage'],
  maxContextTokens: number,
): TokenUsage {
  return {
    inputTokens: usage.promptTokens ?? 0,
    outputTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens,
    maxContextTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheMissInputTokens !== undefined
      ? { cacheMissInputTokens: usage.cacheMissInputTokens }
      : {}),
    ...(usage.billableInputTokens !== undefined
      ? { billableInputTokens: usage.billableInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}
