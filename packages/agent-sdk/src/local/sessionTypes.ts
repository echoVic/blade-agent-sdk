/**
 * Session type definitions extracted from root session/types.ts.
 * Zero root class dependencies.
 */

import type { JsonObject, JsonValue, TokenUsage } from '../types/common.js';
import { DecisionBehavior } from './hookTypes.js';
import type { SessionId } from './branded.js';
import type { Message } from '@blade-ai/ai/chat';

export interface ToolCallRecord {
  id: string;
  name: string;
  input: JsonValue;
  output: string | object;
  duration: number;
  isError?: boolean;
}

export interface SubagentInfo {
  parentSessionId: string;
  subagentType: string;
  depth: number;
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount: number;
  tools?: string[];
  connectedAt?: Date;
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}

export interface StreamOptions {
  includeThinking?: boolean;
}

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: unknown;
}

export interface ForkSessionOptions {
  messageId?: string;
}

export interface ForkSessionResult {
  sessionId: string;
  parentSessionId: string;
  messageCount: number;
  forkedAt?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContextTokens?: number;
}

export interface PromptResult {
  result: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  duration: number;
}

export type StreamMessage =
  | { type: 'turn_start'; turn: number; sessionId: string }
  | { type: 'turn_end'; turn: number; sessionId: string }
  | { type: 'content'; delta: string; sessionId: string }
  | { type: 'thinking'; delta: string; sessionId: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: string }
  | { type: 'tool_progress'; id: string; name: string; message: string; sessionId: string }
  | { type: 'tool_message'; id: string; name: string; message: string; sessionId: string }
  | { type: 'tool_runtime_patch'; id: string; name: string; patch: unknown; sessionId: string }
  | { type: 'tool_context_patch'; id: string; name: string; patch: unknown; sessionId: string };

export interface ProviderConfig {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
}

export interface HookOutput {
  action?: 'continue' | 'skip' | 'abort';
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
  systemMessage?: string;
  suppressOutput?: boolean;
  decision?: { behavior?: DecisionBehavior };
}

export type HookCallback = (input: HookInput) => Promise<HookOutput>;

export interface HookInput {
  event: unknown;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: string | object;
  error?: Error;
  sessionId: string;
  [key: string]: unknown;
}

/**
 * SessionSummary — 会话摘要
 *
 * 用于列表视图，不包含完整消息内容。
 */
export interface SessionSummary {
  sessionId: SessionId;
  lastActivity: number;
  messageCount: number;
  topics: string[];
  summaryText?: string;
}

/**
 * SessionSnapshot — 会话快照
 *
 * 包含完整消息内容，用于恢复会话。
 */
export interface SessionSnapshot {
  sessionId: SessionId;
  messages: Message[];
  messageIds: string[];
  lastActivity: number;
  summary?: string;
}
