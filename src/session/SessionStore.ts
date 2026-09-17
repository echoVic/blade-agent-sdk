import { nanoid } from 'nanoid';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelContent } from '../model/message.js';
import { cloneJsonValue, cloneMessage } from '../services/messageUtils.js';
import type { MessageRole } from '../types/constants.js';
import {
  type InputId,
  MessageId,
  type RequestId,
  type SessionId,
  ToolUseId,
} from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';
import { mergeHistoryProgress, type SessionHistoryProgress } from './historyProgress.js';
import type {
  PersistedToolUse,
  SessionEventStore,
  SessionRepository,
  SessionRepositoryCompactionMetadata,
  SessionRepositoryHealth,
  SessionRepositoryMessageMetadata,
  SessionRepositoryStorageStats,
  SessionRepositorySubagentInfo,
  SessionRepositorySubagentRef,
} from './SessionRepository.js';
import type { PersistedPendingInput, TranscriptSession } from './transcript.js';

interface SessionTimelineEntry {
  id: MessageId;
  parentMessageId?: MessageId;
  createdAt: number;
  message: ConversationMessage;
}

export interface SessionToolCallState {
  id: ToolUseId;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  messageId?: MessageId;
  timestamp: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

interface SessionSubagentRef {
  messageId: MessageId;
  childSessionId: SessionId;
  agentType: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface SessionSummary {
  sessionId: SessionId;
  lastActivity: number;
  messageCount: number;
  topics: string[];
  summaryText?: string;
}

export interface SessionSnapshot {
  sessionId: SessionId;
  messages: ConversationMessage[];
  messageIds: MessageId[];
  lastActivity: number;
  summary?: string;
}

export interface SessionState extends SessionSnapshot {
  createdAt: number;
  sessionInfo: Partial<TranscriptSession>;
  timeline: SessionTimelineEntry[];
  summaryMessageIds: MessageId[];
  toolCalls: SessionToolCallState[];
  subagentRefs: SessionSubagentRef[];
  pendingInputs: PersistedPendingInput[];
  historyProgress?: SessionHistoryProgress;
}

export interface SessionStore {
  loadState(sessionId: SessionId): Promise<SessionState | null>;
  loadMessages(sessionId: SessionId): Promise<ConversationMessage[]>;
  forkState(
    sessionId: SessionId,
    options?: { messageId?: MessageId },
  ): Promise<SessionSnapshot | null>;
  listSessions(): Promise<SessionId[]>;
  getSessionSummary(sessionId: SessionId): Promise<SessionSummary | null>;
}

export class NoopSessionStore implements SessionStore {
  async loadState(): Promise<null> {
    return null;
  }
  async loadMessages(): Promise<[]> {
    return [];
  }
  async forkState(): Promise<null> {
    return null;
  }
  async listSessions(): Promise<[]> {
    return [];
  }
  async getSessionSummary(): Promise<null> {
    return null;
  }
}

export type SessionStateMutation<T> = (state: SessionState, now: number) => T;

function createSessionState(
  sessionId: SessionId,
  now: number,
  subagent?: SessionRepositorySubagentInfo,
): SessionState {
  const timestamp = new Date(now).toISOString();
  return {
    sessionId,
    createdAt: now,
    lastActivity: now,
    sessionInfo: {
      sessionId,
      rootId: subagent?.parentSessionId ?? sessionId,
      parentId: subagent?.parentSessionId,
      relationType: subagent ? 'subagent' : undefined,
      status: 'running',
      agentType: subagent?.subagentType,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    timeline: [],
    messages: [],
    messageIds: [],
    summaryMessageIds: [],
    toolCalls: [],
    subagentRefs: [],
    pendingInputs: [],
  };
}

function appendMessage(
  state: SessionState,
  id: MessageId,
  message: ConversationMessage,
  now: number,
  parentMessageId?: MessageId,
): void {
  state.timeline.push({ id, parentMessageId, createdAt: now, message: cloneMessage(message) });
  state.messages.push(cloneMessage(message));
  state.messageIds.push(id);
  state.lastActivity = now;
  state.sessionInfo.updatedAt = new Date(now).toISOString();
}

function messageMetadata(
  metadata: SessionRepositoryMessageMetadata = {},
): Partial<ConversationMessage> {
  const model = metadata.modelIdentity?.model ?? metadata.model;
  return {
    reasoningContent: metadata.reasoningContent,
    tool_calls: metadata.toolCalls ? structuredClone(metadata.toolCalls) : undefined,
    modelIdentity: metadata.modelIdentity ? structuredClone(metadata.modelIdentity) : undefined,
    providerOptions: metadata.providerOptions,
    provenance: metadata.provenance,
    correlation: metadata.correlation,
    telemetry:
      model || metadata.usage
        ? {
            model,
            usage: metadata.usage
              ? {
                  inputTokens: metadata.usage.input_tokens,
                  outputTokens: metadata.usage.output_tokens,
                }
              : undefined,
          }
        : undefined,
    extensions: metadata.extensions,
  };
}

function readableState(state: SessionState): SessionState {
  const settled = new Set(
    state.toolCalls.filter((call) => call.status !== 'pending').map((call) => call.id),
  );
  const timeline = state.timeline.flatMap((entry) => {
    if (
      entry.message.role === 'tool' &&
      (!entry.message.tool_call_id || !settled.has(ToolUseId(entry.message.tool_call_id)))
    ) {
      return [];
    }
    if (entry.message.role !== 'assistant' || !entry.message.tool_calls?.length) return [entry];
    const toolCalls = entry.message.tool_calls.filter((call) => settled.has(ToolUseId(call.id)));
    if (toolCalls.length === 0 && entry.message.content === '' && !entry.message.reasoningContent) {
      return [];
    }
    return [{ ...entry, message: { ...entry.message, tool_calls: toolCalls } }];
  });
  const messageIds = timeline.map((entry) => entry.id);
  return {
    ...state,
    timeline,
    messageIds,
    messages: timeline.map((entry) => cloneMessage(entry.message)),
    subagentRefs: state.subagentRefs.filter((ref) => messageIds.includes(ref.messageId)),
  };
}

export abstract class ProjectedSessionRepository implements SessionRepository, SessionEventStore {
  abstract initialize(): Promise<void>;
  abstract listSessions(): Promise<SessionId[]>;
  abstract deleteSession(sessionId: SessionId): Promise<void>;
  abstract cleanupOldSessions(): Promise<void>;
  abstract getStorageStats(): Promise<SessionRepositoryStorageStats>;
  abstract checkStorageHealth(): Promise<SessionRepositoryHealth>;
  protected abstract readState(sessionId: SessionId): Promise<SessionState | null>;
  protected abstract updateState<T>(
    sessionId: SessionId,
    create: () => SessionState,
    mutation: SessionStateMutation<T>,
  ): Promise<T>;

  async loadState(sessionId: SessionId): Promise<SessionState | null> {
    const state = await this.readState(sessionId);
    return state ? readableState(state) : null;
  }

  async createSession(
    sessionId: SessionId,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<void> {
    await this.mutate(sessionId, () => undefined, subagentInfo);
  }

  saveMessage(
    sessionId: SessionId,
    role: MessageRole,
    content: string | ModelContent[],
    parentMessageId: MessageId | null = null,
    metadata?: SessionRepositoryMessageMetadata,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    const id = MessageId(nanoid());
    return this.mutate(
      sessionId,
      (state, now) => {
        appendMessage(
          state,
          id,
          { id, role, content: structuredClone(content), ...messageMetadata(metadata) },
          now,
          parentMessageId ?? undefined,
        );
        for (const call of metadata?.toolCalls ?? []) {
          let input: JsonValue = call.function.arguments;
          try {
            input = JSON.parse(call.function.arguments) as JsonValue;
          } catch {
            // Preserve provider text when it is not valid JSON.
          }
          state.toolCalls.push({
            id: ToolUseId(call.id),
            name: call.function.name,
            input,
            messageId: id,
            timestamp: now,
            status: 'pending',
          });
        }
        return id;
      },
      subagentInfo,
    );
  }

  saveInputEnqueued(sessionId: SessionId, input: PersistedPendingInput): Promise<void> {
    return this.mutate(sessionId, (state, now) => {
      state.pendingInputs = [
        ...state.pendingInputs.filter((item) => item.inputId !== input.inputId),
        { ...input, content: cloneJsonValue(input.content) },
      ];
      state.lastActivity = now;
    });
  }

  saveAppliedInputMessage(
    sessionId: SessionId,
    inputId: InputId,
    requestId: RequestId,
    content: string | ModelContent[],
    parentMessageId: MessageId | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<MessageId> {
    const id = MessageId(nanoid());
    return this.mutate(
      sessionId,
      (state, now) => {
        state.pendingInputs = state.pendingInputs.filter((input) => input.inputId !== inputId);
        appendMessage(
          state,
          id,
          {
            id,
            role: 'user',
            content: structuredClone(content),
            correlation: { inputId, requestId },
          },
          now,
          parentMessageId ?? undefined,
        );
        return id;
      },
      subagentInfo,
    );
  }

  saveInputCancelled(sessionId: SessionId, inputId: InputId): Promise<void> {
    return this.mutate(sessionId, (state, now) => {
      state.pendingInputs = state.pendingInputs.filter((input) => input.inputId !== inputId);
      state.lastActivity = now;
    });
  }

  saveToolUse(
    sessionId: SessionId,
    toolName: string,
    input: JsonValue,
    parentMessageId: MessageId | null = null,
    subagentInfo?: SessionRepositorySubagentInfo,
    requestedToolCallId?: ToolUseId,
  ): Promise<PersistedToolUse> {
    const messageId = MessageId(nanoid());
    const toolCallId = requestedToolCallId ?? ToolUseId(nanoid());
    return this.mutate(
      sessionId,
      (state, now) => {
        appendMessage(
          state,
          messageId,
          {
            id: messageId,
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: typeof input === 'string' ? input : JSON.stringify(input),
                },
              },
            ],
          },
          now,
          parentMessageId ?? undefined,
        );
        state.toolCalls.push({
          id: toolCallId,
          name: toolName,
          input: cloneJsonValue(input),
          messageId,
          timestamp: now,
          status: 'pending',
        });
        return { messageId, toolCallId };
      },
      subagentInfo,
    );
  }

  saveToolResult(
    sessionId: SessionId,
    toolId: ToolUseId,
    toolName: string,
    output: JsonValue,
    parentMessageId: MessageId | null = null,
    error?: string,
    subagentInfo?: SessionRepositorySubagentInfo,
    subagentRef?: SessionRepositorySubagentRef,
  ): Promise<MessageId> {
    const id = MessageId(nanoid());
    return this.mutate(
      sessionId,
      (state, now) => {
        appendMessage(
          state,
          id,
          {
            id,
            role: 'tool',
            content: error ? `Error: ${error}` : stringify(output),
            tool_call_id: toolId,
            name: toolName,
          },
          now,
          parentMessageId ?? undefined,
        );
        const call = state.toolCalls.findLast(
          (item) => item.id === toolId && item.status === 'pending',
        );
        if (call) {
          Object.assign(call, {
            output: cloneJsonValue(output),
            error,
            status: error ? 'error' : 'success',
          });
        }
        if (subagentRef) {
          state.subagentRefs.push({
            messageId: id,
            childSessionId: subagentRef.subagentSessionId,
            agentType: subagentRef.subagentType,
            status: subagentRef.subagentStatus,
            summary: subagentRef.subagentSummary,
            startedAt: new Date(now).toISOString(),
            finishedAt:
              subagentRef.subagentStatus === 'running' ? null : new Date(now).toISOString(),
          });
        }
        return id;
      },
      subagentInfo,
    );
  }

  saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentMessageId: MessageId | null = null,
  ): Promise<MessageId> {
    const id = MessageId(nanoid());
    return this.mutate(sessionId, (state, now) => {
      appendMessage(
        state,
        id,
        {
          id,
          role: 'system',
          content: summary,
          provenance: { source: 'compaction_summary' },
          extensions: {
            trigger: metadata.trigger,
            preTokens: metadata.preTokens,
            ...(metadata.postTokens !== undefined ? { postTokens: metadata.postTokens } : {}),
            ...(metadata.filesIncluded ? { filesIncluded: metadata.filesIncluded } : {}),
          },
        },
        now,
        parentMessageId ?? undefined,
      );
      state.summary = summary;
      state.summaryMessageIds.push(id);
      return id;
    });
  }

  saveHistoryProgress(sessionId: SessionId, progress: SessionHistoryProgress): Promise<void> {
    return this.mutate(sessionId, (state) => {
      state.historyProgress = mergeHistoryProgress(state.historyProgress, progress);
    });
  }

  clearHistoryGap(
    sessionId: SessionId,
    repairedMessages: number,
    options: { readonly coveredRequestId?: RequestId } = {},
  ): Promise<void> {
    return this.mutate(sessionId, (state) => {
      state.historyProgress = mergeHistoryProgress(state.historyProgress, {
        state: 'complete',
        updatedAt: Date.now(),
        repairedMessages,
        ...(options.coveredRequestId ? { coveredRequestId: options.coveredRequestId } : {}),
      });
    });
  }

  async loadMessages(sessionId: SessionId): Promise<ConversationMessage[]> {
    return (await this.loadState(sessionId))?.messages.map(cloneMessage) ?? [];
  }

  async forkState(
    sessionId: SessionId,
    options?: { messageId?: MessageId },
  ): Promise<SessionSnapshot | null> {
    const state = await this.loadState(sessionId);
    if (!state) return null;
    const end = options?.messageId ? state.messageIds.indexOf(options.messageId) + 1 : undefined;
    if (end === 0) {
      throw new Error(`Message with ID "${options?.messageId}" not found in session history`);
    }
    const timeline = state.timeline.slice(0, end);
    const summary = [...timeline]
      .reverse()
      .find((entry) => state.summaryMessageIds.includes(entry.id))?.message.content;
    return {
      sessionId,
      messages: timeline.map((entry) => cloneMessage(entry.message)),
      messageIds: timeline.map((entry) => entry.id),
      lastActivity: timeline.at(-1)?.createdAt ?? state.createdAt,
      summary: typeof summary === 'string' ? summary : undefined,
    };
  }

  async getSessionSummary(sessionId: SessionId): Promise<SessionSummary | null> {
    const state = await this.loadState(sessionId);
    return state
      ? {
          sessionId,
          lastActivity: state.lastActivity,
          messageCount: state.messages.filter(
            (message) => message.role === 'user' || message.role === 'assistant',
          ).length,
          topics: [],
          summaryText: state.summary,
        }
      : null;
  }

  private mutate<T>(
    sessionId: SessionId,
    mutation: SessionStateMutation<T>,
    subagentInfo?: SessionRepositorySubagentInfo,
  ): Promise<T> {
    return this.updateState(
      sessionId,
      () => createSessionState(sessionId, Date.now(), subagentInfo),
      mutation,
    );
  }
}

function stringify(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
