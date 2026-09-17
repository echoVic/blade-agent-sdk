import type { ConversationMessage } from '../model/conversation.js';
import type { ModelIdentity } from '../model/identity.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { MessageRole } from '../types/constants.js';
import type { InputId, MessageId, RequestId, SessionId, ToolUseId } from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { SessionHistoryProgress } from './historyProgress.js';
import {
  ProjectedSessionRepository,
  type SessionState,
  type SessionStateMutation,
  type SessionStore,
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

/** Write-side port for atomic Session projection updates. */
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
  /**
   * Record how far the message projection is complete. Committed with the
   * projection, so a later request cannot advance past a recorded gap.
   *
   * Optional: a backend that cannot persist it makes the SDK fall back to a
   * conservative recovery cursor rather than claiming the history is whole.
   */
  saveHistoryProgress?(sessionId: SessionId, progress: SessionHistoryProgress): Promise<void>;
  /**
   * Close a recorded gap after the transcript was verified or rebuilt. Only the
   * repair path calls this: ordinary progress writes never clear a gap.
   *
   * `coveredRequestId` lets repair state which request it just rebuilt, so the
   * projection can claim it as covered instead of losing the boundary it had.
   */
  clearHistoryGap?(
    sessionId: SessionId,
    repairedMessages: number,
    options?: { readonly coveredRequestId?: RequestId },
  ): Promise<void>;
}

/**
 * Non-persistent repository used when callers intentionally run an ephemeral
 * Session without a shared store.
 */
export class NoopSessionRepository extends ProjectedSessionRepository {
  async initialize(): Promise<void> {}

  protected async readState(): Promise<SessionState | null> {
    return null;
  }

  protected async updateState<T>(
    _sessionId: SessionId,
    create: () => SessionState,
    mutation: SessionStateMutation<T>,
  ): Promise<T> {
    return mutation(create(), Date.now());
  }

  async listSessions(): Promise<[]> {
    return [];
  }

  async deleteSession(): Promise<void> {}

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
