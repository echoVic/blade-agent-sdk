import * as fs from 'node:fs/promises';
import { JSONLStore, JSONLStoreError } from '@/context/storage/JSONLStore.js';
import {
  getSessionFilePathFromStorageRoot,
  normalizeSessionStorageRoot,
} from '@/context/storage/pathUtils.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import { cloneJsonValue, cloneMessage } from '../services/messageUtils.js';
import { type MessageId, type PartId, SessionId, ToolUseId } from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { SessionHistoryProgress } from './historyProgress.js';
import type {
  PersistedPendingInput,
  TranscriptEvent,
  TranscriptPart,
  TranscriptSession,
} from './transcript.js';

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

interface MessageRecord extends SessionTimelineEntry {
  parts: Map<PartId, ModelContent>;
}

interface ProjectionBuilder {
  sessionId: SessionId;
  sessionInfo: Partial<TranscriptSession>;
  createdAt: number;
  lastActivity: number;
  messages: Map<MessageId, MessageRecord>;
  toolCalls: Map<ToolUseId, SessionToolCallState>;
  subagentRefs: SessionSubagentRef[];
  summaryMessageIds: MessageId[];
  pendingInputs: Map<string, PersistedPendingInput>;
  summary?: string;
}

function corrupt(message: string): never {
  throw new JSONLStoreError('SESSION_JSONL_CORRUPT_LOG', message);
}

function object(value: JsonValue, subject: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    corrupt(`${subject} must be an object`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== 'string') corrupt(`${subject} must be a string`);
  return value;
}

function messageContent(parts: Map<PartId, ModelContent>): ModelMessage['content'] {
  const values = [...parts.values()];
  return values.length === 1 && values[0]?.type === 'text' ? values[0].text : values;
}

function requireMessage(builder: ProjectionBuilder, part: TranscriptPart): MessageRecord {
  const record = builder.messages.get(part.messageId);
  if (!record) corrupt(`${part.partType} references missing message ${part.messageId}`);
  return record;
}

function addPart(record: MessageRecord, part: TranscriptPart, content: ModelContent): void {
  if (record.parts.has(part.partId)) corrupt(`Duplicate part ID ${part.partId}`);
  record.parts.set(part.partId, content);
  record.message.content = messageContent(record.parts);
}

function applyPart(builder: ProjectionBuilder, part: TranscriptPart): void {
  const record = requireMessage(builder, part);
  const payload = object(part.payload, part.partType);
  switch (part.partType) {
    case 'text':
      addPart(record, part, {
        type: 'text',
        text: stringValue(payload.text, 'text payload'),
        ...(objectOrUndefined(payload.providerOptions)
          ? {
              providerOptions: payload.providerOptions as Extract<
                ModelContent,
                { type: 'text' }
              >['providerOptions'],
            }
          : {}),
      });
      return;
    case 'image':
      addPart(record, part, {
        type: 'image_url',
        image_url: { url: stringValue(payload.dataUrl, 'image payload') },
      });
      return;
    case 'reasoning':
      record.message.reasoningContent = `${record.message.reasoningContent ?? ''}${stringValue(
        payload.text,
        'reasoning payload',
      )}`;
      return;
    case 'tool_call': {
      if (record.message.role !== 'assistant') {
        corrupt(`tool_call ${part.partId} belongs to ${record.message.role} message`);
      }
      const id = ToolUseId(stringValue(payload.toolCallId, 'tool_call ID'));
      if (builder.toolCalls.has(id)) corrupt(`Duplicate tool call ID ${id}`);
      const name = stringValue(payload.toolName, 'tool_call name');
      const input = cloneJsonValue(payload.input);
      const call: ModelToolCall = {
        id,
        type: 'function',
        function: {
          name,
          arguments: typeof input === 'string' ? input : JSON.stringify(input),
        },
      };
      record.message.tool_calls = [...(record.message.tool_calls ?? []), call];
      builder.toolCalls.set(id, {
        id,
        name,
        input,
        messageId: record.id,
        timestamp: record.createdAt,
        status: 'pending',
      });
      return;
    }
    case 'tool_result': {
      if (record.message.role !== 'tool') {
        corrupt(`tool_result ${part.partId} belongs to ${record.message.role} message`);
      }
      const id = ToolUseId(stringValue(payload.toolCallId, 'tool_result ID'));
      const call = builder.toolCalls.get(id);
      if (!call || call.status !== 'pending') corrupt(`tool_result has no pending call ${id}`);
      const name = stringValue(payload.toolName, 'tool_result name');
      if (name !== call.name) corrupt(`tool_result name does not match call ${id}`);
      const output = cloneJsonValue(payload.output);
      const error = typeof payload.error === 'string' ? payload.error : undefined;
      Object.assign(record.message, {
        tool_call_id: id,
        name,
        content: error ? `Error: ${error}` : stringify(output),
      });
      Object.assign(call, { output, error, status: error ? 'error' : 'success' });
      return;
    }
    case 'summary': {
      const text = stringValue(payload.text, 'summary payload');
      record.message.content = text;
      record.message.provenance = { source: 'compaction_summary' };
      record.message.extensions = objectOrUndefined(payload.extensions);
      builder.summary = text;
      builder.summaryMessageIds.push(record.id);
      return;
    }
    case 'subtask_ref': {
      const status = payload.status;
      if (
        status !== 'running' &&
        status !== 'completed' &&
        status !== 'failed' &&
        status !== 'cancelled'
      ) {
        corrupt(`subtask_ref ${part.partId} has invalid status`);
      }
      builder.subagentRefs.push({
        messageId: record.id,
        childSessionId: SessionId(stringValue(payload.childSessionId, 'subtask session ID')),
        agentType: stringValue(payload.agentType, 'subtask agent type'),
        status,
        ...(typeof payload.summary === 'string' ? { summary: payload.summary } : {}),
        ...(typeof payload.startedAt === 'string' ? { startedAt: payload.startedAt } : {}),
        ...(typeof payload.finishedAt === 'string' || payload.finishedAt === null
          ? { finishedAt: payload.finishedAt }
          : {}),
      });
      return;
    }
    default:
      corrupt(`Unsupported transcript part type ${part.partType}`);
  }
}

function objectOrUndefined(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringify(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function applyEvent(builder: ProjectionBuilder, event: TranscriptEvent): void {
  builder.lastActivity = Date.parse(event.timestamp);
  switch (event.type) {
    case 'session_created':
      builder.sessionInfo = { ...event.data, sessionId: builder.sessionId };
      builder.createdAt = Date.parse(event.data.createdAt);
      return;
    case 'session_updated':
      builder.sessionInfo = { ...builder.sessionInfo, ...event.data, sessionId: builder.sessionId };
      return;
    case 'message_created': {
      if (builder.messages.has(event.data.messageId)) {
        corrupt(`Duplicate message ID ${event.data.messageId}`);
      }
      const { data } = event;
      const message: ConversationMessage = {
        id: data.messageId,
        role: data.role,
        content: '',
        modelIdentity: data.modelIdentity,
        providerOptions: data.providerOptions,
        provenance: data.provenance,
        correlation: data.correlation,
        telemetry:
          data.model || data.usage
            ? {
                model: data.model,
                usage: data.usage
                  ? {
                      inputTokens: data.usage.input_tokens,
                      outputTokens: data.usage.output_tokens,
                    }
                  : undefined,
              }
            : undefined,
        extensions: data.extensions,
      };
      builder.messages.set(data.messageId, {
        id: data.messageId,
        parentMessageId: data.parentMessageId,
        createdAt: Date.parse(data.createdAt),
        message,
        parts: new Map(),
      });
      return;
    }
    case 'part_created':
      applyPart(builder, event.data);
      return;
    case 'part_updated': {
      corrupt(`Unsupported transcript event ${event.type}`);
      break;
    }
    case 'input_enqueued':
      builder.pendingInputs.set(event.data.inputId, {
        ...event.data,
        content: cloneJsonValue(event.data.content),
      });
      return;
    case 'input_applied':
    case 'input_cancelled':
      builder.pendingInputs.delete(event.data.inputId);
      return;
  }
}

export class JsonlSessionStore implements SessionStore {
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = normalizeSessionStorageRoot(storageRoot);
  }

  async loadState(sessionId: SessionId): Promise<SessionState | null> {
    const entries = await this.readEntries(sessionId);
    if (entries.length === 0) return null;
    if (entries[0]?.type !== 'session_created') {
      corrupt(`Session ${sessionId} does not start with session_created`);
    }
    const initial = entries[0];
    const builder: ProjectionBuilder = {
      sessionId,
      sessionInfo: { sessionId },
      createdAt: Date.parse(initial.timestamp),
      lastActivity: Date.parse(initial.timestamp),
      messages: new Map(),
      toolCalls: new Map(),
      subagentRefs: [],
      summaryMessageIds: [],
      pendingInputs: new Map(),
    };
    for (const event of entries) applyEvent(builder, event);
    const timeline = [...builder.messages.values()].map(({ parts: _, ...entry }) => entry);
    return {
      sessionId,
      createdAt: builder.createdAt,
      lastActivity: builder.lastActivity,
      sessionInfo: builder.sessionInfo,
      timeline,
      messages: timeline.map((entry) => cloneMessage(entry.message)),
      messageIds: timeline.map((entry) => entry.id),
      summary: builder.summary,
      summaryMessageIds: builder.summaryMessageIds,
      toolCalls: [...builder.toolCalls.values()].map((call) => structuredClone(call)),
      subagentRefs: structuredClone(builder.subagentRefs),
      pendingInputs: [...builder.pendingInputs.values()].map((input) => structuredClone(input)),
    };
  }

  async loadMessages(sessionId: SessionId): Promise<ConversationMessage[]> {
    return (await this.loadState(sessionId))?.messages ?? [];
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
      ...(typeof summary === 'string' ? { summary } : {}),
    };
  }

  async listSessions(): Promise<SessionId[]> {
    try {
      return (await fs.readdir(this.storageRoot, { withFileTypes: true }))
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => SessionId(file.name.slice(0, -'.jsonl'.length)))
        .sort();
    } catch {
      return [];
    }
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

  private async readEntries(sessionId: SessionId): Promise<TranscriptEvent[]> {
    const entries = await new JSONLStore(
      getSessionFilePathFromStorageRoot(this.storageRoot, sessionId),
    ).readAll();
    const mismatched = entries.find((event) => event.sessionId !== sessionId);
    if (mismatched) {
      corrupt(
        `Session JSONL record ${mismatched.id} belongs to ${mismatched.sessionId}, expected ${sessionId}`,
      );
    }
    return entries;
  }
}
