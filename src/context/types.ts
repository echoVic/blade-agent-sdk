/**
 * 上下文管理模块的核心类型定义
 */

import type { MessageRole } from '../types/constants.js';
import type { MessageId, SessionId, ToolUseId } from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';

export interface ContextMessage {
  id: MessageId;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: JsonObject;
}

export interface ContextToolCall {
  id: ToolUseId;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  timestamp: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

export interface SystemContext {
  role: string;
  capabilities: string[];
  tools: string[];
  version: string;
}

export interface SessionContext {
  sessionId: SessionId;
  userId?: string;
  preferences: JsonObject;
  configuration: JsonObject;
  startTime: number;
}

export interface ConversationContext {
  messages: ContextMessage[];
  summary?: string;
  topics: string[];
  lastActivity: number;
}

interface ToolContext {
  recentCalls: ContextToolCall[];
  toolStates: JsonObject;
  dependencies: Record<string, string[]>;
}

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

export interface ContextLayer {
  system: SystemContext;
  session: SessionContext;
  conversation: ConversationContext;
  tool: ToolContext;
  workspace: WorkspaceContext;
}

export interface ContextData {
  layers: ContextLayer;
  metadata: {
    totalTokens: number;
    priority: number;
    relevanceScore?: number;
    lastUpdated: number;
  };
}

export interface ContextFilter {
  maxTokens?: number;
  maxMessages?: number;
  timeWindow?: number; // 毫秒
  priority?: number;
  includeTools?: boolean;
  includeWorkspace?: boolean;
}

export interface CompressedContext {
  summary: string;
  keyPoints: string[];
  recentMessages: ContextMessage[];
  toolSummary?: string;
  tokenCount: number;
}

export interface ContextStorageOptions {
  maxMemorySize: number;
  persistentPath?: string;
  persistenceEnabled?: boolean;
  cacheSize: number;
  compressionEnabled: boolean;
}

export interface ContextManagerOptions {
  storage: ContextStorageOptions;
  defaultFilter: ContextFilter;
  compressionThreshold: number;
  enableVectorSearch?: boolean;
  projectPath?: string;
}
