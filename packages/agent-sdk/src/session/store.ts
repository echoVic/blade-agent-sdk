import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { JsonObject, JsonValue, MessageRole } from '../types/common.js';
import type {
  SessionContentPart,
  SessionMessage,
  SessionToolCall,
} from './types.js';

interface SessionTimelineEntry {
  id: string;
  parentMessageId?: string;
  createdAt: number;
  message: SessionMessage;
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
  messageId: string;
  childSessionId: string;
  agentType: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

interface SessionInfo {
  sessionId: string;
  rootId?: string;
  parentId?: string;
  relationType?: 'subagent';
  title?: string;
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  permission?: JsonValue;
  createdAt?: string;
  updatedAt?: string;
}

interface MessageInfo {
  messageId: string;
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

type PartType =
  | 'text'
  | 'reasoning'
  | 'image'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'patch'
  | 'summary'
  | 'subtask_ref';

interface PartInfo {
  partId: string;
  messageId: string;
  partType: PartType;
  payload: JsonValue;
  createdAt: string;
}

type SessionEvent =
  | { type: 'session_created'; timestamp: string; data: SessionInfo }
  | { type: 'session_updated'; timestamp: string; data: Partial<SessionInfo> }
  | { type: 'message_created'; timestamp: string; data: MessageInfo }
  | { type: 'part_created' | 'part_updated'; timestamp: string; data: PartInfo };

interface MessageRecord {
  id: string;
  parentMessageId?: string;
  createdAt: number;
  message: SessionMessage;
}

export interface SessionSummary {
  sessionId: string;
  lastActivity: number;
  messageCount: number;
  topics: string[];
  summaryText?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  messages: SessionMessage[];
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
}

export interface SessionStore {
  loadState(sessionId: string): Promise<SessionState | null>;
  loadMessages(sessionId: string): Promise<SessionMessage[]>;
  forkState(sessionId: string, options?: { messageId?: string }): Promise<SessionSnapshot | null>;
  writeForkState(
    forkedSessionId: string,
    snapshot: SessionSnapshot | null,
  ): Promise<SessionSnapshot | null>;
  listSessions(): Promise<string[]>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
}

export class NoopSessionStore implements SessionStore {
  async loadState(_sessionId: string): Promise<SessionState | null> {
    return null;
  }

  async loadMessages(_sessionId: string): Promise<SessionMessage[]> {
    return [];
  }

  async forkState(
    _sessionId: string,
    _options?: { messageId?: string },
  ): Promise<SessionSnapshot | null> {
    return null;
  }

  async writeForkState(
    _forkedSessionId: string,
    _snapshot: SessionSnapshot | null,
  ): Promise<SessionSnapshot | null> {
    return null;
  }

  async listSessions(): Promise<string[]> {
    return [];
  }

  async getSessionSummary(_sessionId: string): Promise<SessionSummary | null> {
    return null;
  }
}

function normalizeSessionStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === 'sessions' ? storageRoot : join(storageRoot, 'sessions');
}

function getSessionFilePath(storageRoot: string, sessionId: string): string {
  return join(normalizeSessionStorageRoot(storageRoot), `${sessionId}.jsonl`);
}

function toTimestamp(value: string | undefined, fallback: string): number {
  return new Date(value ?? fallback).getTime();
}

function cloneJsonValue<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSessionMessage(message: SessionMessage): SessionMessage {
  return JSON.parse(JSON.stringify(message)) as SessionMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function inferRole(partType: PartType): MessageRole {
  switch (partType) {
    case 'tool_result':
      return 'tool';
    case 'summary':
      return 'system';
    default:
      return 'assistant';
  }
}

function toMessageContent(parts: SessionContentPart[]): SessionMessage['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return [...parts];
}

function upsertContentPart(
  contentParts: Map<string, Array<{ partId: string; content: SessionContentPart }>>,
  messageId: string,
  partId: string,
  content: SessionContentPart,
): SessionContentPart[] {
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

function getToolCallState(
  toolCalls: Map<string, SessionToolCallState>,
  toolCallId: string,
  defaults: Omit<SessionToolCallState, 'id'>,
): SessionToolCallState {
  const existing = toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const created: SessionToolCallState = {
    id: toolCallId,
    ...defaults,
  };
  toolCalls.set(toolCallId, created);
  return created;
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return isRecord(value) && typeof value.type === 'string' && typeof value.timestamp === 'string';
}

export class JsonlSessionStore implements SessionStore {
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = normalizeSessionStorageRoot(storageRoot);
  }

  async loadState(sessionId: string): Promise<SessionState | null> {
    const entries = await this.readEntries(sessionId);
    if (entries.length === 0) {
      return null;
    }

    const messageRecords = new Map<string, MessageRecord>();
    const contentParts = new Map<string, Array<{ partId: string; content: SessionContentPart }>>();
    const orderedMessageIds: string[] = [];
    const summaryMessageIds = new Set<string>();
    const toolCalls = new Map<string, SessionToolCallState>();
    const subagentRefs: SessionSubagentRef[] = [];
    let sessionInfo: Partial<SessionInfo> = { sessionId };
    let createdAt = toTimestamp(undefined, entries[0]?.timestamp ?? new Date().toISOString());
    let lastActivity = createdAt;
    let summary: string | undefined;

    const ensureMessageRecord = (
      messageId: string,
      role: MessageRole,
      timestamp: string,
      parentMessageId?: string,
    ): MessageRecord => {
      const existing = messageRecords.get(messageId);
      if (existing) {
        if (parentMessageId) {
          existing.parentMessageId = parentMessageId;
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

        if (data.model || data.usage || data.customMetadata) {
          record.message.metadata = {
            ...(data.model ? { model: data.model } : {}),
            ...(data.usage ? { usage: data.usage } : {}),
            ...(data.customMetadata ?? {}),
          };
        }

        continue;
      }

      const data = entry.data;
      const record = ensureMessageRecord(
        data.messageId,
        inferRole(data.partType),
        entry.timestamp,
      );

      this.applyPartToMessage({
        part: data,
        record,
        contentParts,
        toolCalls,
        subagentRefs,
        summaryMessageIds,
        onSummary: (value) => {
          summary = value;
        },
      });
    }

    const timeline = orderedMessageIds
      .map((messageId) => messageRecords.get(messageId))
      .filter((record): record is MessageRecord => record !== undefined)
      .map((record) => ({
        id: record.id,
        parentMessageId: record.parentMessageId,
        createdAt: record.createdAt,
        message: record.message,
      }));

    const messageIds = timeline.map((entry) => entry.id);
    const messages = timeline.map((entry) => cloneSessionMessage(entry.message));
    const snapshotSummary =
      this.getLastSummaryForIds(messageIds, summaryMessageIds, timeline) ?? summary;

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
      toolCalls: Array.from(toolCalls.values()).map((toolCall) => ({ ...toolCall })),
      subagentRefs: subagentRefs.map((ref) => ({ ...ref })),
    };
  }

  async loadMessages(sessionId: string): Promise<SessionMessage[]> {
    const state = await this.loadState(sessionId);
    return state?.messages ?? [];
  }

  async forkState(
    sessionId: string,
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
    const messages = timeline.map((entry) => cloneSessionMessage(entry.message));

    return {
      sessionId,
      messages,
      messageIds,
      lastActivity:
        timeline.length > 0 ? timeline.at(-1)?.createdAt ?? state.createdAt : state.createdAt,
      summary: this.getLastSummaryForIds(messageIds, new Set(state.summaryMessageIds), timeline),
    };
  }

  async writeForkState(
    forkedSessionId: string,
    snapshot: SessionSnapshot | null,
  ): Promise<SessionSnapshot | null> {
    if (!snapshot) {
      return null;
    }

    const now = new Date().toISOString();
    const entries: SessionEvent[] = [
      this.createSessionCreatedEvent({
        sessionId: forkedSessionId,
        parentId: snapshot.sessionId,
        createdAt: now,
        updatedAt: now,
      }),
    ];
    const materializedMessages: SessionMessage[] = [];
    const messageIds: string[] = [];

    for (const message of snapshot.messages) {
      const messageId = message.id ?? nanoid();
      const materializedMessage: SessionMessage = {
        ...cloneSessionMessage(message),
        id: messageId,
      };
      const createdAt = now;
      messageIds.push(messageId);
      materializedMessages.push(materializedMessage);
      entries.push(
        this.createMessageCreatedEvent({
          messageId,
          role: materializedMessage.role,
          createdAt,
          customMetadata: isRecord(materializedMessage.metadata)
            ? materializedMessage.metadata
            : undefined,
        }),
      );
      entries.push(...this.createPartEventsForMessage(messageId, materializedMessage, createdAt));
    }

    await this.writeEntries(forkedSessionId, entries);

    return {
      sessionId: forkedSessionId,
      messages: materializedMessages.map(cloneSessionMessage),
      messageIds,
      lastActivity: Date.now(),
      summary: snapshot.summary,
    };
  }

  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.storageRoot, { withFileTypes: true });
      return files
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => file.name.replace(/\.jsonl$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
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

  private async readEntries(sessionId: string): Promise<SessionEvent[]> {
    try {
      const filePath = getSessionFilePath(this.storageRoot, sessionId);
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as unknown;
            return isSessionEvent(parsed) ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private createSessionCreatedEvent(data: SessionInfo): SessionEvent {
    return {
      type: 'session_created',
      timestamp: new Date().toISOString(),
      data,
    };
  }

  private createMessageCreatedEvent(data: MessageInfo): SessionEvent {
    return {
      type: 'message_created',
      timestamp: new Date().toISOString(),
      data,
    };
  }

  private createPartCreatedEvent(data: PartInfo): SessionEvent {
    return {
      type: 'part_created',
      timestamp: new Date().toISOString(),
      data,
    };
  }

  private async writeEntries(sessionId: string, entries: SessionEvent[]): Promise<void> {
    const filePath = getSessionFilePath(this.storageRoot, sessionId);
    await fs.mkdir(this.storageRoot, { recursive: true, mode: 0o755 });
    await fs.writeFile(
      filePath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf-8',
    );
  }

  private createPartEventsForMessage(
    messageId: string,
    message: SessionMessage,
    createdAt: string,
  ): SessionEvent[] {
    const entries: SessionEvent[] = [];
    if (message.reasoningContent) {
      entries.push(
        this.createPartCreatedEvent({
          partId: nanoid(),
          messageId,
          partType: 'reasoning',
          payload: { text: message.reasoningContent },
          createdAt,
        }),
      );
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        entries.push(
          this.createPartCreatedEvent({
            partId: toolCall.id,
            messageId,
            partType: 'tool_call',
            payload: {
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              input: this.parseToolCallArguments(toolCall.function.arguments),
            },
            createdAt,
          }),
        );
      }
    }

    if (message.role === 'tool') {
      entries.push(
        this.createPartCreatedEvent({
          partId: message.tool_call_id ?? nanoid(),
          messageId,
          partType: 'tool_result',
          payload: {
            toolCallId: message.tool_call_id ?? messageId,
            toolName: message.name ?? 'unknown',
            output: this.parseToolResultContent(message.content),
          },
          createdAt,
        }),
      );
      return entries;
    }

    if (typeof message.content === 'string') {
      if (message.content.length > 0) {
        const payload: JsonObject = { text: message.content };
        if (message.role === 'system' && message.metadata !== undefined) {
          payload.metadata = message.metadata;
        }
        entries.push(
          this.createPartCreatedEvent({
            partId: nanoid(),
            messageId,
            partType: message.role === 'system' ? 'summary' : 'text',
            payload,
            createdAt,
          }),
        );
      }
      return entries;
    }

    for (const part of message.content) {
      entries.push(
        this.createPartCreatedEvent({
          partId: nanoid(),
          messageId,
          partType: part.type === 'text' ? 'text' : 'image',
          payload:
            part.type === 'text'
              ? { text: part.text }
              : { dataUrl: part.image_url.url },
          createdAt,
        }),
      );
    }

    return entries;
  }

  private parseToolCallArguments(value: string): JsonValue {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }

  private parseToolResultContent(value: SessionMessage['content']): JsonValue {
    if (typeof value !== 'string') {
      return value.map((part): JsonObject =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: { url: part.image_url.url } },
      );
    }
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }

  private applyPartToMessage(params: {
    part: PartInfo;
    record: MessageRecord;
    contentParts: Map<string, Array<{ partId: string; content: SessionContentPart }>>;
    toolCalls: Map<string, SessionToolCallState>;
    subagentRefs: SessionSubagentRef[];
    summaryMessageIds: Set<string>;
    onSummary: (summary: string) => void;
  }): void {
    const {
      part,
      record,
      contentParts,
      toolCalls,
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
        const nextParts = upsertContentPart(contentParts, record.id, part.partId, {
          type: 'text',
          text: typeof payload.text === 'string' ? payload.text : '',
        });
        record.message.content = toMessageContent(nextParts);
        break;
      }
      case 'image': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const url =
          typeof payload.dataUrl === 'string'
            ? payload.dataUrl
            : typeof payload.url === 'string'
              ? payload.url
              : '';
        const nextParts = upsertContentPart(contentParts, record.id, part.partId, {
          type: 'image_url',
          image_url: { url },
        });
        record.message.content = toMessageContent(nextParts);
        break;
      }
      case 'tool_call': {
        const payload = isRecord(part.payload) ? part.payload : {};
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const toolCallId =
          typeof payload.toolCallId === 'string' ? payload.toolCallId : part.partId;
        const input = cloneJsonValue(payload.input as JsonValue);
        const toolCall: SessionToolCall = {
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

        const toolCallState = getToolCallState(toolCalls, toolCallId, {
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
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const output = cloneJsonValue(payload.output as JsonValue);
        const error = typeof payload.error === 'string' ? payload.error : undefined;

        record.message.role = 'tool';
        record.message.tool_call_id = toolCallId;
        record.message.name = toolName;
        record.message.content = error ? `Error: ${error}` : stringifyContent(output);

        const toolCallState = getToolCallState(toolCalls, toolCallId, {
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
        const agentType = typeof payload.agentType === 'string' ? payload.agentType : undefined;
        const status = payload.status;
        if (
          childSessionId &&
          agentType &&
          (status === 'running' ||
            status === 'completed' ||
            status === 'failed' ||
            status === 'cancelled')
        ) {
          subagentRefs.push({
            messageId: record.id,
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
    timeline: Array<{ id: string; message: SessionMessage }>,
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
