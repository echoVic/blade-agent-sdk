import { nanoid } from 'nanoid';
import type { ContextData } from '../context/types.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelIdentity } from '../model/identity.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { MessageRole } from '../types/constants.js';
import {
  type InputId,
  MessageId,
  type RequestId,
  type SessionId,
  ToolUseId,
} from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  SessionSnapshot,
  SessionState,
  SessionStore,
  SessionSummary,
} from './SessionStore.js';
import type { PersistedPendingInput } from './transcript.js';

export interface SessionRepositorySubagentInfo {
  parentSessionId: SessionId;
  subagentType: string;
  isSidechain: boolean;
}

export interface SessionRepositoryMessageMetadata {
  model?: string;
  modelIdentity?: ModelIdentity;
  usage?: { input_tokens: number; output_tokens: number };
  providerOptions?: ModelMessage['providerOptions'];
  provenance?: ConversationMessage['provenance'];
  correlation?: ConversationMessage['correlation'];
  extensions?: JsonObject;
  reasoningContent?: string;
  toolCalls?: ModelToolCall[];
}

export interface SessionRepositorySubagentRef {
  subagentSessionId: SessionId;
  subagentType: string;
  subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
  subagentSummary?: string;
}

export interface SessionRepositoryCompactionMetadata {
  trigger: 'auto' | 'manual';
  preTokens: number;
  postTokens?: number;
  filesIncluded?: string[];
}

export interface PersistedToolUse {
  messageId: MessageId;
  toolCallId: ToolUseId;
}

export interface SessionRepositoryStorageStats {
  totalSessions: number;
  totalSize: number;
  projectPath?: string;
}

export interface SessionRepositoryHealth {
  isAvailable: boolean;
  canWrite: boolean;
  error?: string;
}

/** Read-side Session projection port. */
export interface SessionRepository extends SessionStore {
  initialize(): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
  cleanupOldSessions(): Promise<void>;
  getStorageStats(): Promise<SessionRepositoryStorageStats>;
  checkStorageHealth(): Promise<SessionRepositoryHealth>;
}

/** Append-only transcript event port used to update Session projections. */
export interface SessionEventStore {
  createSession(sessionId: SessionId, subagentInfo?: SessionRepositorySubagentInfo): Promise<void>;
  saveMessage(
    sessionId: SessionId,
    messageRole: MessageRole,
    content: string | ModelContent[],
    parentMessageId?: MessageId | null,
    metadata?: SessionRepositoryMessageMetadata,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId>;
  saveInputEnqueued(sessionId: SessionId, input: PersistedPendingInput): Promise<void>;
  saveAppliedInputMessage(
    sessionId: SessionId,
    inputId: InputId,
    requestId: RequestId,
    content: string | ModelContent[],
    parentMessageId?: MessageId | null,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId>;
  saveInputCancelled(sessionId: SessionId, inputId: InputId, reason: string): Promise<void>;
  saveToolUse(
    sessionId: SessionId,
    toolName: string,
    toolInput: JsonValue,
    parentMessageId?: MessageId | null,
    subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: ToolUseId,
  ): Promise<PersistedToolUse>;
  saveToolResult(
    sessionId: SessionId,
    toolId: ToolUseId,
    toolName: string,
    toolOutput: JsonValue,
    parentMessageId?: MessageId | null,
    error?: string,
    subagentInfo?: SessionRepositorySubagentInfo,
    subagentRef?: SessionRepositorySubagentRef,
  ): Promise<MessageId>;
  saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentMessageId?: MessageId | null,
  ): Promise<MessageId>;
  saveContext(sessionId: SessionId, contextData: ContextData): Promise<void>;
}

/** Compatibility port for backends that expose reads and appends together. */
export interface SessionPersistence extends SessionRepository, SessionEventStore {}

export function isSessionEventStore(
  value: SessionRepository | SessionEventStore | undefined,
): value is SessionEventStore {
  if (!value) {
    return false;
  }
  return [
    'createSession',
    'saveMessage',
    'saveInputEnqueued',
    'saveAppliedInputMessage',
    'saveInputCancelled',
    'saveToolUse',
    'saveToolResult',
    'saveCompaction',
    'saveContext',
  ].every((method) => typeof Reflect.get(value, method) === 'function');
}

/**
 * Non-persistent repository used when callers intentionally run an ephemeral
 * Session without a shared store.
 */
export class NoopSessionRepository implements SessionPersistence {
  async initialize(): Promise<void> {}

  async createSession(
    _sessionId: SessionId,
    _subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<void> {}

  async saveMessage(
    _sessionId: SessionId,
    _messageRole: MessageRole,
    _content: string | ModelContent[],
    _parentMessageId: MessageId | null = null,
    _metadata?: SessionRepositoryMessageMetadata,
    _subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    return MessageId(nanoid());
  }

  async saveInputEnqueued(_sessionId: SessionId, _input: PersistedPendingInput): Promise<void> {}

  async saveAppliedInputMessage(
    _sessionId: SessionId,
    _inputId: InputId,
    _requestId: RequestId,
    _content: string | ModelContent[],
    _parentMessageId: MessageId | null = null,
    _subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    return MessageId(nanoid());
  }

  async saveInputCancelled(
    _sessionId: SessionId,
    _inputId: InputId,
    _reason: string,
  ): Promise<void> {}

  async saveToolUse(
    _sessionId: SessionId,
    _toolName: string,
    _toolInput: JsonValue,
    _parentMessageId: MessageId | null = null,
    _subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: ToolUseId,
  ): Promise<PersistedToolUse> {
    return {
      messageId: MessageId(nanoid()),
      toolCallId: requestedToolCallId ?? ToolUseId(nanoid()),
    };
  }

  async saveToolResult(
    _sessionId: SessionId,
    _toolId: ToolUseId,
    _toolName: string,
    _toolOutput: JsonValue,
    _parentMessageId: MessageId | null = null,
    _error?: string,
    _subagentInfo?: SessionRepositorySubagentInfo,
    _subagentRef?: SessionRepositorySubagentRef,
  ): Promise<MessageId> {
    return MessageId(nanoid());
  }

  async saveCompaction(
    _sessionId: SessionId,
    _summary: string,
    _metadata: SessionRepositoryCompactionMetadata,
    _parentMessageId: MessageId | null = null,
  ): Promise<MessageId> {
    return MessageId(nanoid());
  }

  async saveContext(_sessionId: SessionId, _contextData: ContextData): Promise<void> {}

  async loadState(_sessionId: SessionId): Promise<SessionState | null> {
    return null;
  }

  async loadMessages(_sessionId: SessionId): Promise<ModelMessage[]> {
    return [];
  }

  async forkState(
    _sessionId: SessionId,
    _options?: { messageId?: MessageId },
  ): Promise<SessionSnapshot | null> {
    return null;
  }

  async listSessions(): Promise<SessionId[]> {
    return [];
  }

  async getSessionSummary(_sessionId: SessionId): Promise<SessionSummary | null> {
    return null;
  }

  async deleteSession(_sessionId: SessionId): Promise<void> {}

  async cleanupOldSessions(): Promise<void> {}

  async getStorageStats(): Promise<SessionRepositoryStorageStats> {
    return {
      totalSessions: 0,
      totalSize: 0,
    };
  }

  async checkStorageHealth(): Promise<SessionRepositoryHealth> {
    return {
      isAvailable: false,
      canWrite: false,
      error: 'Session persistence is disabled',
    };
  }
}
