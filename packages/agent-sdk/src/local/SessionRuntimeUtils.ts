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

import type { Message } from '@blade-ai/ai/chat';
import type { JsonObject } from '@blade-ai/ai';

/**
 * Type guard: checks if a value is a valid tool call array.
 */
export function isSessionToolCallArray(value: unknown): value is NonNullable<Message['tool_calls']> {
  return Array.isArray(value) && value.every(isSessionToolCall);
}

/**
 * Type guard: checks if a value is a valid individual tool call.
 */
export function isSessionToolCall(value: unknown): value is NonNullable<Message['tool_calls']>[number] {
  if (!isJsonObject(value)) {
    return false;
  }
  const fn = value.function;
  return (
    typeof value.id === 'string'
    && value.type === 'function'
    && isJsonObject(fn)
    && typeof fn.name === 'string'
    && typeof fn.arguments === 'string'
  );
}

/**
 * Type guard: checks if a value is a plain JSON object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard: checks if a value has the shape of usage metadata
 * with input_tokens and output_tokens number fields.
 */
export function isUsageMetadata(
  value: unknown,
): value is { input_tokens: number; output_tokens: number } {
  return isJsonObject(value)
    && typeof value.input_tokens === 'number'
    && typeof value.output_tokens === 'number';
}

import type { ToolCall as ChatToolCall } from '@blade-ai/ai/chat';

/**
 * Type guard: checks if a value is a valid ChatToolCall.
 */
export function isChatToolCall(value: unknown): value is ChatToolCall {
  return isJsonObject(value)
    && typeof value.id === 'string'
    && value.type === 'function'
    && isJsonObject(value.function)
    && typeof value.function.name === 'string'
    && typeof value.function.arguments === 'string';
}

/**
 * Type guard: checks if a value is an array of ChatToolCall items.
 */
export function isChatToolCallArray(value: unknown): value is ChatToolCall[] {
  return Array.isArray(value) && value.every(isChatToolCall);
}
