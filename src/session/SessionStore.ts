import * as fs from 'node:fs/promises';
import {
  JSONLStore,
  JSONLStoreError,
} from '@/context/storage/JSONLStore.js';
import {
  getSessionFilePathFromStorageRoot,
  normalizeSessionStorageRoot,
} from '@/context/storage/pathUtils.js';
import type {
  PartInfo,
  PendingInputInfo,
  SessionEvent,
  SessionInfo,
} from '../context/types.js';
import type { ContentPart, Message, ToolCall } from '../services/ChatServiceInterface.js';
import { cloneJsonValue, cloneMessage } from '../services/messageUtils.js';
import type { JsonValue, MessageRole } from '../types/common.js';
import { MessageId, type SessionId } from '../types/branded.js';

interface SessionTimelineEntry {
  id: string;
  parentMessageId?: string;
  createdAt: number;
  message: Message;
}

interface SessionToolCallState {
  id: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  messageId?: string;
  timestamp: number;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

interface SessionSubagentRef {
  messageId: MessageId;
  childSessionId: string;
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
  messages: Message[];
  messageIds: string[];
  lastActivity: number;
  summary?: string;
}

export interface SessionState extends SessionSnapshot {
  createdAt: number;
  sessionInfo: Partial<SessionInfo>;
  timeline: SessionTimelineEntry[];
  summaryMessageIds: string[];
  toolCalls: SessionToolCallState[];
  subagentRefs: SessionSubagentRef[];
  pendingInputs: PendingInputInfo[];
}

export interface SessionStore {
  loadState(sessionId: SessionId): Promise<SessionState | null>;
  loadMessages(sessionId: SessionId): Promise<Message[]>;
  forkState(
    sessionId: SessionId,
    options?: { messageId?: string },
  ): Promise<SessionSnapshot | null>;
  listSessions(): Promise<string[]>;
  getSessionSummary(sessionId: SessionId): Promise<SessionSummary | null>;
}

export class NoopSessionStore implements SessionStore {
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
}

interface MessageRecord {
  id: string;
  parentMessageId?: string;
  createdAt: number;
  message: Message;
}

function toTimestamp(value: string | undefined, fallback: string): number {
  return new Date(value ?? fallback).getTime();
}

/**
 * Collapse a ContentPart[] down to `Message['content']`.
 * Single text-only part is returned as a plain string for backward compat.
 *
 * NOTE: no cloning — this operates on the internal builder state.
 * The final export to `SessionState` is protected by `cloneMessage`.
 */
function toMessageContent(parts: ContentPart[]): Message['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return [...parts];
}

/**
 * Insert or replace a content part in the per-message part list.
 *
 * No cloning is performed — the `content` argument is always a freshly
 * constructed object literal at every call site, and the returned array
 * is only used to fill the mutable builder record.  The boundary clone
 * happens later in `cloneMessage` when the record is exported.
 */
function upsertContentPart(
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
  return existing.map((part) => part.content);
}

function stringifyContent(value: unknown): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferRole(partType: string): MessageRole {
  switch (partType) {
    case 'tool_result':
      return 'tool';
    case 'summary':
      return 'system';
    default:
      return 'assistant';
  }
}

function isEmptyAssistantMessage(message: Message): boolean {
  return message.role === 'assistant'
    && message.content === ''
    && !message.reasoningContent
    && !message.tool_calls?.length;
}

interface ToolCallOccurrence {
  key: string;
  sourceMessageId: string;
  toolCallId: string;
  matched: boolean;
}

interface ToolOccurrencePlan {
  callsByEventId: Map<string, ToolCallOccurrence>;
  resultsByEventId: Map<string, ToolCallOccurrence>;
}

function getPartToolCallId(part: PartInfo): string {
  const payload = isRecord(part.payload) ? part.payload : {};
  return typeof payload.toolCallId === 'string' ? payload.toolCallId : part.partId;
}

function createToolOccurrencePlan(entries: SessionEvent[]): ToolOccurrencePlan {
  const callsByEventId = new Map<string, ToolCallOccurrence>();
  const resultsByEventId = new Map<string, ToolCallOccurrence>();
  const callsBySource = new Map<string, ToolCallOccurrence>();
  const latestResultBySource = new Map<string, ToolCallOccurrence>();
  const unmatchedByToolCallId = new Map<string, ToolCallOccurrence[]>();
  let occurrenceIndex = 0;

  for (const entry of entries) {
    if (entry.type !== 'part_created' && entry.type !== 'part_updated') continue;
    const part = entry.data;
    if (part.partType !== 'tool_call' && part.partType !== 'tool_result') continue;

    const toolCallId = getPartToolCallId(part);
    const sourceKey = `${part.messageId}\0${toolCallId}`;

    if (part.partType === 'tool_call') {
      let occurrence = callsBySource.get(sourceKey);
      if (!occurrence) {
        occurrence = {
          key: `tool-call:${occurrenceIndex++}`,
          sourceMessageId: part.messageId,
          toolCallId,
          matched: false,
        };
        callsBySource.set(sourceKey, occurrence);
        const unmatched = unmatchedByToolCallId.get(toolCallId) ?? [];
        unmatched.push(occurrence);
        unmatchedByToolCallId.set(toolCallId, unmatched);
      }
      callsByEventId.set(entry.id, occurrence);
      continue;
    }

    let occurrence = entry.type === 'part_updated'
      ? latestResultBySource.get(sourceKey)
      : undefined;
    if (!occurrence) {
      const unmatched = unmatchedByToolCallId.get(toolCallId) ?? [];
      occurrence = unmatched.shift();
      if (!occurrence) continue;
      occurrence.matched = true;
      latestResultBySource.set(sourceKey, occurrence);
    }
    resultsByEventId.set(entry.id, occurrence);
  }

  return { callsByEventId, resultsByEventId };
}

function getToolCallState(
  toolCalls: Map<string, SessionToolCallState>,
  stateKey: string,
  defaults: SessionToolCallState,
): SessionToolCallState {
  const existing = toolCalls.get(stateKey);
  if (existing) {
    return existing;
  }

  toolCalls.set(stateKey, defaults);
  return defaults;
}

export class JsonlSessionStore implements SessionStore {
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = normalizeSessionStorageRoot(storageRoot);
  }

  async loadState(sessionId: SessionId): Promise<SessionState | null> {
    const entries = await this.readEntries(sessionId);
    if (entries.length === 0) {
      return null;
    }

    const messageRecords = new Map<string, MessageRecord>();
    const contentParts = new Map<string, Array<{ partId: string; content: ContentPart }>>();
    const orderedMessageIds: string[] = [];
    const summaryMessageIds = new Set<string>();
    const toolCalls = new Map<string, SessionToolCallState>();
    const toolOccurrencePlan = createToolOccurrencePlan(entries);
    const projectedCallMessageIds = new Map<string, MessageId>();
    const callMessageIdsByOccurrence = new Map<string, MessageId>();
    const resultMessageIdsByOccurrence = new Map<string, MessageId>();
    const resultOccurrenceByMessageId = new Map<string, string>();
    const subagentRefs: SessionSubagentRef[] = [];
    const pendingInputs = new Map<string, PendingInputInfo>();
    let sessionInfo: Partial<SessionInfo> = { sessionId };
    let createdAt = toTimestamp(undefined, entries[0]?.timestamp ?? new Date().toISOString());
    let lastActivity = createdAt;
    let summary: string | undefined;

    const ensureMessageRecord = (
      messageId: MessageId,
      role: MessageRole,
      timestamp: string,
      parentMessageId?: string,
    ): MessageRecord => {
      const existing = messageRecords.get(messageId);
      if (existing) {
        if (parentMessageId) {
          existing.parentMessageId = parentMessageId;
        }
        if (!existing.message.id) {
          existing.message.id = messageId;
        }
        if (!existing.message.role) {
          existing.message.role = role;
        }
        return existing;
      }

      const record: MessageRecord = {
        id: messageId,
        parentMessageId,
        createdAt: toTimestamp(undefined, timestamp),
        message: {
          id: messageId,
          role,
          content: '',
        },
      };
      messageRecords.set(messageId, record);
      orderedMessageIds.push(messageId);
      return record;
    };

    for (const entry of entries) {
      lastActivity = toTimestamp(undefined, entry.timestamp);

      if (entry.type === 'session_created') {
        sessionInfo = { ...entry.data, sessionId };
        createdAt = toTimestamp(entry.data.createdAt, entry.timestamp);
        continue;
      }

      if (entry.type === 'session_updated') {
        sessionInfo = { ...sessionInfo, ...entry.data, sessionId };
        continue;
      }

      if (entry.type === 'message_created') {
        const data = entry.data;
        const record = ensureMessageRecord(
          data.messageId,
          data.role,
          entry.timestamp,
          data.parentMessageId,
        );
        record.createdAt = toTimestamp(data.createdAt, entry.timestamp);
        record.parentMessageId = data.parentMessageId;
        record.message.role = data.role;
        record.message.id = data.messageId;
        record.message.modelIdentity = data.modelIdentity
          ? { ...data.modelIdentity }
          : undefined;

        if (data.model || data.usage || data.customMetadata) {
          record.message.metadata = {
            ...(data.model ? { model: data.model } : {}),
            ...(data.usage ? { usage: data.usage } : {}),
            ...(data.customMetadata && typeof data.customMetadata === 'object' ? data.customMetadata as Record<string, unknown> : {}),
          };
        }

        continue;
      }

      if (entry.type === 'input_enqueued') {
        pendingInputs.set(entry.data.inputId, {
          ...entry.data,
          content: cloneJsonValue(entry.data.content),
        });
        continue;
      }

      if (entry.type === 'input_applied' || entry.type === 'input_cancelled') {
        pendingInputs.delete(entry.data.inputId);
        continue;
      }

      if (entry.type !== 'part_created' && entry.type !== 'part_updated') {
        continue;
      }

      const data = entry.data;
      const occurrence = data.partType === 'tool_call'
        ? toolOccurrencePlan.callsByEventId.get(entry.id)
        : data.partType === 'tool_result'
          ? toolOccurrencePlan.resultsByEventId.get(entry.id)
          : undefined;
      if ((data.partType === 'tool_call' || data.partType === 'tool_result') && !occurrence) {
        continue;
      }
      if (data.partType === 'tool_call' && !occurrence?.matched) {
        continue;
      }

      let messageId = data.messageId;
      let inferredParentMessageId: string | undefined;
      if (data.partType === 'tool_call' && occurrence) {
        const sourceRecord = messageRecords.get(data.messageId);
        if (sourceRecord && sourceRecord.message.role !== 'assistant') {
          messageId = projectedCallMessageIds.get(data.messageId)
            ?? MessageId(`${data.messageId}:tool-calls`);
          projectedCallMessageIds.set(data.messageId, messageId);
          inferredParentMessageId = data.messageId;
        }
        callMessageIdsByOccurrence.set(occurrence.key, messageId);
      } else if (data.partType === 'tool_result' && occurrence) {
        const projectedMessageId = resultMessageIdsByOccurrence.get(occurrence.key);
        if (projectedMessageId) {
          messageId = projectedMessageId;
        } else {
          const sourceRecord = messageRecords.get(data.messageId);
          const currentOwner = resultOccurrenceByMessageId.get(data.messageId);
          if (
            (sourceRecord && sourceRecord.message.role !== 'tool')
            || (currentOwner && currentOwner !== occurrence.key)
          ) {
            messageId = MessageId(`${data.messageId}:tool-result:${occurrence.key}`);
          }
          resultMessageIdsByOccurrence.set(occurrence.key, messageId);
          resultOccurrenceByMessageId.set(messageId, occurrence.key);
        }
        inferredParentMessageId = callMessageIdsByOccurrence.get(occurrence.key);
      }

      const record = ensureMessageRecord(
        messageId,
        inferRole(data.partType),
        entry.timestamp,
        messageRecords.has(messageId) ? undefined : inferredParentMessageId,
      );

      this.applyPartToMessage({
        part: data,
        record,
        contentParts,
        toolCalls,
        toolOccurrenceKey: occurrence?.key,
        subagentRefs,
        summaryMessageIds,
        onSummary: (value) => {
          summary = value;
        },
      });
    }

    // Build the timeline directly from the mutable builder records (no clone).
    // `messages` is cloned from the same records so the two arrays are independent.
    const records = orderedMessageIds
      .map((messageId) => messageRecords.get(messageId))
      .filter((record): record is MessageRecord => record !== undefined);
    const referencedMessageIds = new Set([
      ...records.flatMap((record) => record.parentMessageId ? [record.parentMessageId] : []),
      ...subagentRefs.map((ref) => String(ref.messageId)),
    ]);
    const timeline = records
      .filter((record) => !isEmptyAssistantMessage(record.message)
        || referencedMessageIds.has(record.id))
      .map((record) => ({
        id: record.id,
        parentMessageId: record.parentMessageId,
        createdAt: record.createdAt,
        message: record.message,
      }));

    const messageIds = timeline.map((entry) => entry.id);
    const messages = timeline.map((entry) => cloneMessage(entry.message));
    const snapshotSummary = this.getLastSummaryForIds(messageIds, summaryMessageIds, timeline) ?? summary;

    return {
      sessionId,
      createdAt,
      lastActivity,
      sessionInfo,
      timeline,
      messages,
      messageIds,
      summary: snapshotSummary,
      summaryMessageIds: Array.from(summaryMessageIds),
      // input/output already cloned when written into the map (applyPartToMessage),
      // so a shallow spread is sufficient here.
      toolCalls: Array.from(toolCalls.values()).map((toolCall) => ({
        ...toolCall,
      })),
      subagentRefs: subagentRefs
        .filter((ref) => messageIds.includes(String(ref.messageId)))
        .map((ref) => ({ ...ref })),
      pendingInputs: Array.from(pendingInputs.values()).map((input) => ({
        ...input,
        content: cloneJsonValue(input.content),
      })),
    };
  }

  async loadMessages(sessionId: SessionId): Promise<Message[]> {
    const state = await this.loadState(sessionId);
    return state?.messages ?? [];
  }

  async forkState(
    sessionId: SessionId,
    options?: { messageId?: string },
  ): Promise<SessionSnapshot | null> {
    const state = await this.loadState(sessionId);
    if (!state) {
      return null;
    }

    let endIndex = state.timeline.length;
    if (options?.messageId) {
      const index = state.messageIds.indexOf(options.messageId);
      if (index === -1) {
        throw new Error(`Message with ID "${options.messageId}" not found in session history`);
      }
      endIndex = index + 1;
    }

    const timeline = state.timeline.slice(0, endIndex);
    const messageIds = timeline.map((entry) => entry.id);
    const messages = timeline.map((entry) => cloneMessage(entry.message));

    return {
      sessionId,
      messages,
      messageIds,
      lastActivity: timeline.length > 0
        ? (timeline.at(-1)?.createdAt ?? state.createdAt)
        : state.createdAt,
      summary: this.getLastSummaryForIds(
        messageIds,
        new Set(state.summaryMessageIds),
        timeline,
      ),
    };
  }

  async listSessions(): Promise<string[]> {
    try {
      const storagePath = this.storageRoot;
      const files = await fs.readdir(storagePath, { withFileTypes: true });
      return files
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => file.name.replace(/\.jsonl$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  async getSessionSummary(sessionId: SessionId): Promise<SessionSummary | null> {
    const state = await this.loadState(sessionId);
    if (!state) {
      return null;
    }

    return {
      sessionId,
      lastActivity: state.lastActivity,
      messageCount: state.messages.filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      ).length,
      topics: [],
      summaryText: state.summary,
    };
  }

  private async readEntries(sessionId: SessionId): Promise<SessionEvent[]> {
    const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
    const store = new JSONLStore(filePath);
    const entries = await store.readAll();
    const mismatched = entries.find((entry) => entry.sessionId !== sessionId);
    if (mismatched) {
      throw new JSONLStoreError(
        'SESSION_JSONL_CORRUPT_LOG',
        `Session JSONL record ${mismatched.id} belongs to ${mismatched.sessionId}, expected ${sessionId}`,
      );
    }
    return entries;
  }

  private applyPartToMessage(params: {
    part: PartInfo;
    record: MessageRecord;
    contentParts: Map<string, Array<{ partId: string; content: ContentPart }>>;
    toolCalls: Map<string, SessionToolCallState>;
    toolOccurrenceKey?: string;
    subagentRefs: SessionSubagentRef[];
    summaryMessageIds: Set<string>;
    onSummary: (summary: string) => void;
  }): void {
    const {
      part,
      record,
      contentParts,
      toolCalls,
      toolOccurrenceKey,
      subagentRefs,
      summaryMessageIds,
      onSummary,
    } = params;

    switch (part.partType) {
      case 'reasoning': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const text = typeof payload.text === 'string' ? payload.text : '';
        record.message.role = 'assistant';
        record.message.reasoningContent = record.message.reasoningContent
          ? `${record.message.reasoningContent}${text}`
          : text;
        break;
      }
      case 'text': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const providerOptions = isRecord(payload.providerOptions)
          ? payload.providerOptions as Extract<ContentPart, { type: 'text' }>['providerOptions']
          : undefined;
        const nextParts = upsertContentPart(contentParts, MessageId(record.id), part.partId, {
          type: 'text',
          text: typeof payload.text === 'string' ? payload.text : '',
          ...(providerOptions ? { providerOptions } : {}),
        });
        record.message.content = toMessageContent(nextParts);
        break;
      }
      case 'image': {
        const payload = isRecord(part.payload) ? part.payload : {};
        // `dataUrl` is the canonical field written by PersistentStore; `url` is
        // accepted as a legacy / external-source fallback.
        const url = typeof payload.dataUrl === 'string'
          ? payload.dataUrl
          : typeof payload.url === 'string'
            ? payload.url
            : '';
        const nextParts = upsertContentPart(contentParts, MessageId(record.id), part.partId, {
          type: 'image_url',
          image_url: {
            url,
          },
        });
        record.message.content = toMessageContent(nextParts);
        break;
      }
      case 'tool_call': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const toolName =
          typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const toolCallId =
          typeof payload.toolCallId === 'string' ? payload.toolCallId : part.partId;
        const input = cloneJsonValue(payload.input as JsonValue);
        const toolCall: ToolCall = {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: typeof input === 'string' ? input : stringifyContent(input),
          },
        };

        record.message.role = 'assistant';
        record.message.tool_calls = [
          ...(record.message.tool_calls ?? []).filter((call) => call.id !== toolCall.id),
          toolCall,
        ];

        const toolCallState = getToolCallState(toolCalls, toolOccurrenceKey ?? toolCallId, {
          id: toolCallId,
          name: toolName,
          input,
          messageId: record.id,
          timestamp: record.createdAt,
          status: 'pending',
        });
        toolCallState.messageId = record.id;
        break;
      }
      case 'tool_result': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const toolCallId =
          typeof payload.toolCallId === 'string' ? payload.toolCallId : part.partId;
        const toolName =
          typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const output = cloneJsonValue(payload.output as JsonValue);
        const error =
          typeof payload.error === 'string' ? payload.error : undefined;

        record.message.role = 'tool';
        record.message.tool_call_id = toolCallId;
        record.message.name = toolName;
        record.message.content = error ? `Error: ${error}` : stringifyContent(output);

        const toolCallState = getToolCallState(toolCalls, toolOccurrenceKey ?? toolCallId, {
          id: toolCallId,
          name: toolName,
          input: {},
          messageId: record.id,
          timestamp: record.createdAt,
          status: error ? 'error' : 'success',
        });
        toolCallState.name = toolName;
        toolCallState.messageId = record.id;
        toolCallState.output = output;
        toolCallState.status = error ? 'error' : 'success';
        toolCallState.error = error;
        break;
      }
      case 'summary': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const text = typeof payload.text === 'string' ? payload.text : '';
        record.message.role = 'system';
        record.message.content = text;
        if (payload.metadata !== undefined) {
          record.message.metadata = payload.metadata as JsonValue;
        }
        summaryMessageIds.add(record.id);
        onSummary(text);
        break;
      }
      case 'subtask_ref': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const childSessionId =
          typeof payload.childSessionId === 'string' ? payload.childSessionId : undefined;
        const agentType =
          typeof payload.agentType === 'string' ? payload.agentType : undefined;
        const status = payload.status;
        if (
          childSessionId &&
          agentType &&
          (status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled')
        ) {
          subagentRefs.push({
            messageId: MessageId(record.id),
            childSessionId,
            agentType,
            status,
            summary: typeof payload.summary === 'string' ? payload.summary : undefined,
            startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : undefined,
            finishedAt:
              typeof payload.finishedAt === 'string' || payload.finishedAt === null
                ? payload.finishedAt
                : undefined,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private getLastSummaryForIds(
    messageIds: string[],
    summaryMessageIds: Set<string>,
    timeline: Array<{ id: string; message: Message }>,
  ): string | undefined {
    for (let index = messageIds.length - 1; index >= 0; index -= 1) {
      const messageId = messageIds[index];
      if (!messageId || !summaryMessageIds.has(messageId)) {
        continue;
      }

      const entry = timeline.find((item) => item.id === messageId);
      if (entry && typeof entry.message.content === 'string') {
        return entry.message.content;
      }
    }

    return undefined;
  }
}
