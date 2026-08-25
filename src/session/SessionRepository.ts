import { nanoid } from 'nanoid';
import type { ContentPart, Message, ModelIdentity, ToolCall } from '../services/ChatServiceInterface.js';
import type { InputId, RequestId, SessionId } from '../types/branded.js';
import type { JsonObject, JsonValue, MessageRole } from '../types/common.js';
import type {
  ContextData,
  PendingInputInfo,
} from '../context/types.js';
import type {
  SessionSnapshot,
  SessionState,
  SessionSummary,
  SessionStore,
} from './SessionStore.js';

export interface SessionRepositorySubagentInfo {
  parentSessionId: string;
  subagentType: string;
  isSidechain: boolean;
}

export interface SessionRepositoryMessageMetadata {
  model?: string;
  modelIdentity?: ModelIdentity;
  usage?: { input_tokens: number; output_tokens: number };
  customMetadata?: JsonObject;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
}

export interface SessionRepositorySubagentRef {
  subagentSessionId: string;
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
  messageId: string;
  toolCallId: string;
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
  createSession(
    sessionId: SessionId,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<void>;
  saveMessage(
    sessionId: SessionId,
    messageRole: MessageRole,
    content: string | ContentPart[],
    parentUuid?: string | null,
    metadata?: SessionRepositoryMessageMetadata,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string>;
  saveInputEnqueued(sessionId: SessionId, input: PendingInputInfo): Promise<void>;
  saveAppliedInputMessage(
    sessionId: SessionId,
    inputId: InputId,
    requestId: RequestId,
    content: string | ContentPart[],
    parentUuid?: string | null,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string>;
  saveInputCancelled(
    sessionId: SessionId,
    inputId: InputId,
    reason: string,
  ): Promise<void>;
  saveToolUse(
    sessionId: SessionId,
    toolName: string,
    toolInput: JsonValue,
    parentUuid?: string | null,
    subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: string,
  ): Promise<PersistedToolUse>;
  saveToolResult(
    sessionId: SessionId,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid?: string | null,
    error?: string,
    subagentInfo?: SessionRepositorySubagentInfo,
    subagentRef?: SessionRepositorySubagentRef,
  ): Promise<string>;
  saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentUuid?: string | null,
  ): Promise<string>;
  saveContext(sessionId: SessionId, contextData: ContextData): Promise<void>;
}

/** Compatibility port for backends that expose reads and appends together. */
export interface SessionPersistence
  extends SessionRepository, SessionEventStore {}

export function isSessionEventStore(
  value: SessionRepository | SessionEventStore | undefined,
): value is SessionEventStore {
  if (!value) {
    return false;
  }
  const candidate = value as unknown as Record<string, unknown>;
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
  ].every((method) => typeof candidate[method] === 'function');
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
    _content: string | ContentPart[],
    _parentUuid: string | null = null,
    _metadata?: SessionRepositoryMessageMetadata,
    _subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string> {
    return nanoid();
  }

  async saveInputEnqueued(
    _sessionId: SessionId,
    _input: PendingInputInfo,
  ): Promise<void> {}

  async saveAppliedInputMessage(
    _sessionId: SessionId,
    _inputId: InputId,
    _requestId: RequestId,
    _content: string | ContentPart[],
    _parentUuid: string | null = null,
    _subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<string> {
    return nanoid();
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
    _parentUuid: string | null = null,
    _subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: string,
  ): Promise<PersistedToolUse> {
    return {
      messageId: nanoid(),
      toolCallId: requestedToolCallId ?? nanoid(),
    };
  }

  async saveToolResult(
    _sessionId: SessionId,
    _toolId: string,
    _toolName: string,
    _toolOutput: JsonValue,
    _parentUuid: string | null = null,
    _error?: string,
    _subagentInfo?: SessionRepositorySubagentInfo,
    _subagentRef?: SessionRepositorySubagentRef,
  ): Promise<string> {
    return nanoid();
  }

  async saveCompaction(
    _sessionId: SessionId,
    _summary: string,
    _metadata: SessionRepositoryCompactionMetadata,
    _parentUuid: string | null = null,
  ): Promise<string> {
    return nanoid();
  }

  async saveContext(_sessionId: SessionId, _contextData: ContextData): Promise<void> {}

  async loadState(_sessionId: SessionId): Promise<SessionState | null> {
    return null;
  }

  async loadMessages(_sessionId: SessionId): Promise<Message[]> {
    return [];
  }

  async forkState(
    _sessionId: SessionId,
    _options?: { messageId?: string },
  ): Promise<SessionSnapshot | null> {
    return null;
  }

  async listSessions(): Promise<string[]> {
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
