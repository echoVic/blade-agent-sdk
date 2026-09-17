import { nanoid } from 'nanoid';
import { ConfigError } from '../errors/ConfigError.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import {
  NoopSessionRepository,
  type PersistedToolUse,
  type SessionEventStore,
  type SessionRepository,
  type SessionRepositoryCompactionMetadata,
  type SessionRepositoryMessageMetadata,
  type SessionRepositorySubagentInfo,
  type SessionRepositorySubagentRef,
} from '../session/SessionRepository.js';
import type { PersistedPendingInput } from '../session/transcript.js';
import {
  type InputId,
  type MessageId,
  type RequestId,
  SessionId,
  type ToolUseId,
} from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';

/**
 * Typed transcript boundary shared by Session and Agent execution.
 *
 * Read projections and append operations are separate ports. The class only
 * coordinates those ports; conversation state belongs to Session/Agent.
 */
export class ContextManager {
  private readonly repository: SessionRepository;
  private readonly eventStore: SessionEventStore;
  private initialized = false;

  constructor(repository?: SessionRepository, eventStore?: SessionEventStore) {
    if ((repository && !eventStore) || (!repository && eventStore)) {
      throw new ConfigError(
        'Persistent context requires both SessionRepository and SessionEventStore.',
      );
    }
    const noop = new NoopSessionRepository();
    this.repository = repository ?? noop;
    this.eventStore = eventStore ?? noop;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.repository.initialize();
    this.initialized = true;
  }

  async createSession(sessionId = SessionId(nanoid())): Promise<SessionId> {
    await this.eventStore.createSession(sessionId);
    return sessionId;
  }

  async loadSession(sessionId: SessionId): Promise<boolean> {
    return (await this.repository.loadState(sessionId)) !== null;
  }

  async recordHistoryWriteFailure(
    sessionId: SessionId,
    detail: string,
    scope?: { readonly requestId?: RequestId },
  ): Promise<void> {
    try {
      await this.eventStore.saveHistoryProgress?.(sessionId, {
        state: 'failed',
        updatedAt: Date.now(),
        detail,
        ...(scope?.requestId ? { requestId: scope.requestId } : {}),
      });
    } catch (error) {
      console.warn('[ContextManager] Failed to persist history gap:', error);
    }
  }

  saveMessage(
    sessionId: SessionId,
    role: ModelMessage['role'],
    content: ModelMessage['content'],
    parentMessageId: MessageId | null = null,
    metadata?: SessionRepositoryMessageMetadata,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    return this.eventStore.saveMessage(
      sessionId,
      role,
      content,
      parentMessageId,
      metadata,
      subagentInfo,
    );
  }

  saveInputEnqueued(sessionId: SessionId, input: PersistedPendingInput): Promise<void> {
    return this.eventStore.saveInputEnqueued(sessionId, input);
  }

  saveAppliedInputMessage(
    sessionId: SessionId,
    inputId: InputId,
    requestId: RequestId,
    content: string | ModelContent[],
    parentMessageId: MessageId | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    return this.eventStore.saveAppliedInputMessage(
      sessionId,
      inputId,
      requestId,
      content,
      parentMessageId,
      subagentInfo,
    );
  }

  saveInputCancelled(sessionId: SessionId, inputId: InputId, reason: string): Promise<void> {
    return this.eventStore.saveInputCancelled(sessionId, inputId, reason);
  }

  saveToolUse(
    sessionId: SessionId,
    toolName: string,
    toolInput: JsonValue,
    parentMessageId: MessageId | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: ToolUseId,
  ): Promise<PersistedToolUse> {
    return this.eventStore.saveToolUse(
      sessionId,
      toolName,
      toolInput,
      parentMessageId,
      subagentInfo,
      requestedToolCallId,
    );
  }

  saveToolResult(
    sessionId: SessionId,
    toolId: ToolUseId,
    toolName: string,
    toolOutput: JsonValue,
    parentMessageId: MessageId | null = null,
    error?: string,
    subagentInfo?: SessionRepositorySubagentInfo,
    subagentRef?: SessionRepositorySubagentRef,
  ): Promise<MessageId> {
    return this.eventStore.saveToolResult(
      sessionId,
      toolId,
      toolName,
      toolOutput,
      parentMessageId,
      error,
      subagentInfo,
      subagentRef,
    );
  }

  saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentMessageId: MessageId | null = null,
  ): Promise<MessageId> {
    return this.eventStore.saveCompaction(sessionId, summary, metadata, parentMessageId);
  }
}
