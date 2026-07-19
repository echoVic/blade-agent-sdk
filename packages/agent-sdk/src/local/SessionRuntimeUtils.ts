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

/**
 * Checks whether a tool belongs to a specific MCP server.
 * Matches by tool tag or legacy name prefix `mcp__<server>__`.
 */
export function matchesMcpServer(tool: Tool, serverName: string): boolean {
  const legacyPrefix = `mcp__${serverName}__`;
  return tool.tags.includes(serverName) || tool.name.startsWith(legacyPrefix);
}

import type { AgentPermissionUpdate } from '@blade-ai/agent/protocol';
import type { ConversationState } from '@blade-ai/agent/state';
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
import type { ChatContext } from './agentTypes.js';
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

import { HookEvent } from './constants.js';
import type { SessionId } from './branded.js';
import type { HookInput } from '../session/types.js';

/**
 * Builds a HookInput object from hook event data.
 */
export function buildHookInput(
  sessionId: SessionId,
  event: HookEvent,
  payload: Record<string, unknown>,
): HookInput {
  return {
    event,
    sessionId,
    ...payload,
  };
}

import type { JsonValue } from '@blade-ai/ai';

/**
 * Extracts the MIME type from a URL.
 * Supports data: URLs (extracts declared MIME type) and remote URLs
 * (infers from file extension like .png, .jpg, etc.).
 */
export function extractMimeType(url: string): string | undefined {
  // data: URLs — extract the declared MIME type
  const dataMatch = /^data:([^;,]+)[;,]/.exec(url);
  if (dataMatch) {
    return dataMatch[1];
  }

  // Remote URLs — attempt to infer MIME type from file extension
  const extMatch = /\.(\w+)(?:[?#]|$)/.exec(url);
  if (extMatch) {
    const ext = (extMatch[1] ?? '').toLowerCase();
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
    };
    if (mimeMap[ext]) {
      return mimeMap[ext];
    }
  }

  return undefined;
}

/**
 * Parses tool call arguments from a string, attempting JSON parsing first.
 * Returns the parsed value or the original string if parsing fails.
 */
export function parseToolCallArguments(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

/**
 * Extracts a typed string from a JSON object parameter bag.
 * Returns the value if it is a string; otherwise returns the default.
 */
export function getString(params: JsonObject, key: string, defaultValue = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : defaultValue;
}

/**
 * Sanitizes a string segment for use as a filename component.
 * Replaces non-alphanumeric characters with hyphens, truncates to 64 chars,
 * and falls back to 'artifact' if the result would be empty.
 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'artifact';
}

/**
 * Coerces an unknown value into a JsonObject record.
 * Returns the fallback if the value is not a non-array object.
 */
export function toParamsRecord(params: unknown, fallback: JsonObject): JsonObject {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as JsonObject
    : fallback;
}

/**
 * Converts a string or object to a JSON-safe value.
 * Strings pass through unchanged; objects are serialized via JSON round-trip;
 * fallback returns String(value) on serialization failure.
 */
export function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

import type { ContentPart } from '@blade-ai/ai/chat';
import type { MessageId } from './branded.js';

/**
 * Converts a date string to a Unix timestamp in milliseconds.
 */
export function toTimestamp(value: string | undefined, fallback: string): number {
  return new Date(value ?? fallback).getTime();
}

/**
 * Collapses a ContentPart[] down to Message['content'].
 * Single text-only part is returned as a plain string for backward compat.
 */
export function toMessageContent(parts: ContentPart[]): Message['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return [...parts];
}

/**
 * Inserts or replaces a content part in the per-message part list.
 */
export function upsertContentPart(
  contentParts: Map<string, Array<{ partId: string; content: ContentPart }>>,
  messageId: MessageId,
  partId: string,
  content: ContentPart,
): ContentPart[] {
  const existing = contentParts.get(messageId) ?? [];
  const index = existing.findIndex((part) => part.partId === partId);

  if (index === -1) {
    existing.push({ partId, content });
  } else {
    existing[index] = { partId, content };
  }

  contentParts.set(messageId, existing);
  return [...existing.map((p) => p.content)];
}

/**
 * Converts an unknown value to a string representation.
 * Uses JSON.stringify for objects, String() as fallback.
 */
export function stringifyContent(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Checks whether a key looks like a file path key.
 */
export function isPathLikeKey(key: string): boolean {
  return key === 'path'
    || key.endsWith('_path')
    || key.endsWith('Path')
    || key === 'file'
    || key === 'directory';
}

/**
 * Converts an unknown value to a string for error display.
 */
export function formatUnknown(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * Formats a tool description from its component parts.
 */
export function formatToolDescription(description: {
  short: string;
  long?: string;
  usageNotes?: string[];
  important?: string[];
}): string {
  let fullDescription = description.short;

  if (description.long) {
    fullDescription += `\n\n${description.long}`;
  }

  if (description.usageNotes && description.usageNotes.length > 0) {
    fullDescription += `\n\nUsage Notes:\n${description.usageNotes.map((note) => `- ${note}`).join('\n')}`;
  }

  if (description.important && description.important.length > 0) {
    fullDescription += `\n\nImportant:\n${description.important.map((note) => `\u26a0\ufe0f ${note}`).join('\n')}`;
  }

  return fullDescription;
}
import type { ZodIssue } from 'zod';
interface ZodIssueExtra {
  received?: unknown;
  expected?: unknown;
  minimum?: number;
  inclusive?: boolean;
  validation?: string | { includes?: string; startsWith?: string; endsWith?: string };
  maximum?: number;
  type?: unknown;
  options?: unknown[];
  keys?: unknown[];
}


export function translateZodIssue(issue: ZodIssue): string {
  const { code } = issue;
  const extra = issue as ZodIssueExtra;
  const received = extra.received;

  switch (code) {
    case 'invalid_type': {
      const expected = extra.expected;
      return `类型错误：期望 ${formatUnknown(expected)}，实际收到 ${formatUnknown(received)}`;
    }

    case 'too_small': {
      const minimum = extra.minimum;
      const inclusive = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof minimum === 'number') {
        return `长度不能少于 ${minimum} 个字符`;
      }
      if (issueType === 'number' && typeof minimum === 'number') {
        return `不能小于${inclusive ? '等于' : ''} ${minimum}`;
      }
      if (issueType === 'array' && typeof minimum === 'number') {
        return `数组长度不能少于 ${minimum}`;
      }
      return `值太小`;
    }

    case 'too_big': {
      const maximum = extra.maximum;
      const inclusiveMax = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof maximum === 'number') {
        return `长度不能超过 ${maximum} 个字符`;
      }
      if (issueType === 'number' && typeof maximum === 'number') {
        return `不能大于${inclusiveMax ? '等于' : ''} ${maximum}`;
      }
      if (issueType === 'array' && typeof maximum === 'number') {
        return `数组长度不能超过 ${maximum}`;
      }
      return `值太大`;
    }

    case 'invalid_string': {
      const validation = extra.validation;
      if (validation === 'email') {
        return '必须是有效的电子邮件地址';
      }
      if (validation === 'url') {
        return '必须是有效的 URL';
      }
      if (validation === 'uuid') {
        return '必须是有效的 UUID';
      }
      if (isJsonObject(validation)) {
        const v = validation as Record<string, unknown>;
        if (typeof v.includes === 'string') {
          return `必须包含 "${v.includes}"`;
        }
        if (typeof v.startsWith === 'string') {
          return `必须以 "${v.startsWith}" 开头`;
        }
        if (typeof v.endsWith === 'string') {
          return `必须以 "${v.endsWith}" 结尾`;
        }
      }
      return '字符串格式不正确';
    }

    case 'invalid_enum_value': {
      const options = extra.options;
      if (Array.isArray(options)) {
        return `必须是以下值之一：${options.map((o) => formatUnknown(o)).join(', ')}`;
      }
      return '必须是枚举允许的值之一';
    }

    case 'invalid_literal': {
      const expected_literal = extra.expected;
      return `必须是字面量值：${formatUnknown(expected_literal)}`;
    }

    case 'unrecognized_keys': {
      const keys = extra.keys;
      if (Array.isArray(keys)) {
        return `包含未知的参数：${keys.map((k) => formatUnknown(k)).join(', ')}`;
      }
      return '包含未知的参数';
    }

    case 'invalid_union':
      return '不符合任何有效的类型定义';

    case 'invalid_date':
      return '必须是有效的日期';

    case 'custom':
      return issue.message || '自定义验证失败';

    default:
      return issue.message || '验证失败';
  }
}
/**
 * Infers file-system paths from tool parameters.
 * Selects values whose keys look like path descriptors and values from
 * array fields named 'paths' or 'files'.
 */
export function inferAffectedPaths(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return [];
  }

  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(params as JsonObject)) {
    if (typeof value === 'string' && isPathLikeKey(key)) {
      const normalized = value.trim();
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (Array.isArray(value) && (key === 'paths' || key === 'files')) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') {
          candidates.add(item.trim());
        }
      }
    }
  }

  return [...candidates];
}

/**
 * Type guard: checks if a value is a plain record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether user message content contains persistable data
 * (non-empty text or image_url parts).
 */
export function hasPersistableUserContent(message: { type: string; text: string }[]): boolean {
  if (!Array.isArray(message)) {
    return false;
  }
  return message.some((part) => part.type === 'image_url' || (part.text ?? '').trim() !== '');
}

/**
 * Synchronizes context messages from a ConversationState into a ChatContext.
 * Used to keep the chat context in sync with the conversation state.
 */
export function syncContextMessages(context: ChatContext, convState: ConversationState): void {
  context.messages = convState.getContextMessages();
}

/** Sources that can trigger a tool confirmation reason. */
export type ConfirmationReasonSource = 'tool' | 'rule' | 'path' | 'handler' | 'hook';

/** Returns a human-readable default message for a confirmation reason source. */
export function defaultReasonMessage(source: ConfirmationReasonSource): string {
  switch (source) {
    case 'tool': return 'Tool-specific confirmation required';
    case 'rule': return 'User confirmation required';
    case 'path': return 'Path safety confirmation required';
    case 'hook': return 'Hook requires confirmation';
    case 'handler': return 'User confirmation required';
  }
}
