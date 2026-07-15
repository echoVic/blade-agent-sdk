/**
 * Context seed types for the @blade-ai/agent-sdk package.
 *
 * Provides canonical type definitions for context messages and related structures.
 * Root context/storage files (CacheStore, JSONLStore, MemoryStore, PersistentStore)
 * will eventually import these types from here.
 *
 * These are pure interface/type definitions — no runtime dependencies.
 */

import type { JsonObject, JsonValue } from '@blade-ai/ai';
import type { MessageId, SessionId } from './branded.js';

/** Message role — valid sender identities in a conversation. */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** A single message in the conversation context. */
export interface ContextMessage {
  /** Unique identifier for this message. */
  id: string;
  /** The role/sender of the message. */
  role: MessageRole;
  /** The textual content of the message. */
  content: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Optional metadata attached to the message. */
  metadata?: JsonObject;
}

/** Context storage configuration options. */
export interface ContextStorageOptions {
  /** Maximum number of messages to keep in memory. */
  maxMemorySize: number;
  /** Optional filesystem path for persistent storage. */
  persistentPath?: string;
}

/** Context data after compaction — summary + key points + recent messages. */
export interface CompressedContext {
  /** Human-readable summary of the compacted context. */
  summary: string;
  /** Key points extracted from the compacted context. */
  keyPoints: string[];
  /** The most recent messages preserved after compaction. */
  recentMessages: ContextMessage[];
  /** Optional summary of tool usage during the compacted period. */
  toolSummary?: string;
  /** Token count after compaction. */
  tokenCount: number;
}

// ── SessionEvent type hierarchy ──────────────────────────────────────────

/** All possible part types in a session message. */
export type PartType =
  | 'text'
  | 'reasoning'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref';

/** JSONL event type discriminator. */
export type JSONLEventType =
  | 'session_created'
  | 'session_updated'
  | 'message_created'
  | 'part_created'
  | 'part_updated';

/** Session metadata carried by session_created events. */
export interface SessionInfo {
  sessionId: SessionId;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent';
  title?: string;
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  permission?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

/** Message metadata carried by message_created events. */
export interface MessageInfo {
  messageId: MessageId;
  role: MessageRole;
  parentMessageId?: string;
  createdAt: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  customMetadata?: JsonObject;
}

/** Part metadata carried by part_created / part_updated events. */
export interface PartInfo {
  partId: string;
  messageId: MessageId;
  partType: PartType;
  payload: JsonValue;
  createdAt: string;
}

/** Common fields shared by every JSONL event line. */
export interface SessionEventBase {
  id: string;
  sessionId: SessionId;
  timestamp: string;
  type: JSONLEventType;
  cwd?: string;
  gitBranch?: string;
  version: string;
}

/** Discriminated union of all possible JSONL session events. */
export type SessionEvent =
  | (SessionEventBase & { type: 'session_created'; data: SessionInfo })
  | (SessionEventBase & { type: 'session_updated'; data: Partial<SessionInfo> })
  | (SessionEventBase & { type: 'message_created'; data: MessageInfo })
  | (SessionEventBase & { type: 'part_created'; data: PartInfo })
  | (SessionEventBase & { type: 'part_updated'; data: PartInfo });

/** A context-specific tool call record (different from @blade-ai/ai/chat ToolCall). */
export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  timestamp: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

/** System-level context (capabilities, tools, version). */
export interface SystemContext {
  role: string;
  capabilities: string[];
  tools: string[];
  version: string;
}

/** Per-session context (preferences, configuration, timing). */
export interface SessionContext {
  sessionId: SessionId;
  userId?: string;
  preferences: JsonObject;
  configuration: JsonObject;
  startTime: number;
}

/** Conversation history context. */
export interface ConversationContext {
  messages: ContextMessage[];
  summary?: string;
  topics: string[];
  lastActivity: number;
}

/** Tool invocation state context — NOT exported (private to the module). */
interface ToolContext {
  recentCalls: ToolCall[];
  toolStates: JsonObject;
  dependencies: Record<string, string[]>;
}

/** Workspace-level context (filesystem, git, environment). */
export interface WorkspaceContext {
  projectPath?: string;
  currentFiles: string[];
  recentFiles: string[];
  gitInfo?: {
    branch: string;
    status: string;
    lastCommit?: string;
  };
  environment: JsonObject;
}

/** Layered context model — single unified view of all context dimensions. */
export interface ContextLayer {
  system: SystemContext;
  session: SessionContext;
  conversation: ConversationContext;
  tool: ToolContext;
  workspace: WorkspaceContext;
}

/** The top-level context object passed through the system. */
export interface ContextData {
  layers: ContextLayer;
  metadata: {
    totalTokens: number;
    priority: number;
    relevanceScore?: number;
    lastUpdated: number;
  };
}
