import * as fs from 'node:fs/promises';
import { JSONLStore } from '@/context/storage/JSONLStore.js';
import { getProjectStoragePath, getSessionFilePath } from '@/context/storage/pathUtils.js';
import type { PartInfo, SessionEvent, SessionInfo } from '../context/types.js';
import type { Message, ToolCall } from '../services/ChatServiceInterface.js';
import type { JsonValue, MessageRole } from '../types/common.js';

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
  messageId: string;
  childSessionId: string;
  agentType: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  startedAt?: string;
  finishedAt?: string | null;
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
}

export interface SessionStore {
  loadState(sessionId: string): Promise<SessionState | null>;
  loadMessages(sessionId: string): Promise<Message[]>;
  forkState(
    sessionId: string,
    options?: { messageId?: string },
  ): Promise<SessionSnapshot | null>;
  listSessions(): Promise<string[]>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
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

function cloneJsonValue<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

function cloneContent(content: Message['content']): Message['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return {
        type: 'text',
        text: part.text,
        providerOptions: part.providerOptions
          ? cloneJsonValue(part.providerOptions as JsonValue) as typeof part.providerOptions
          : undefined,
      };
    }

    return {
      type: 'image_url',
      image_url: {
        url: part.image_url.url,
      },
    };
  });
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: cloneContent(message.content),
    tool_calls: message.tool_calls?.map(cloneToolCall),
    metadata: cloneJsonValue(message.metadata),
  };
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

export class JsonlSessionStore implements SessionStore {
  constructor(private readonly workspaceRoot: string) {}

  async loadState(sessionId: string): Promise<SessionState | null> {
    const entries = await this.readEntries(sessionId);
    if (entries.length === 0) {
      return null;
    }

    const messageRecords = new Map<string, MessageRecord>();
    const orderedMessageIds: string[] = [];
    const summaryMessageIds = new Set<string>();
    const toolCalls = new Map<string, SessionToolCallState>();
    const subagentRefs: SessionSubagentRef[] = [];
    let sessionInfo: Partial<SessionInfo> = { sessionId };
    let createdAt = toTimestamp(undefined, entries[0]!.timestamp);
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

        if (data.model || data.usage) {
          record.message.metadata = {
            ...(data.model ? { model: data.model } : {}),
            ...(data.usage ? { usage: data.usage } : {}),
          };
        }

        continue;
      }

      if (entry.type !== 'part_created' && entry.type !== 'part_updated') {
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
        message: cloneMessage(record.message),
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
      toolCalls: Array.from(toolCalls.values()).map((toolCall) => ({
        ...toolCall,
        input: cloneJsonValue(toolCall.input),
        output: cloneJsonValue(toolCall.output),
      })),
      subagentRefs: subagentRefs.map((ref) => ({ ...ref })),
    };
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
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
    const messages = timeline.map((entry) => cloneMessage(entry.message));

    return {
      sessionId,
      messages,
      messageIds,
      lastActivity: timeline.length > 0
        ? timeline[timeline.length - 1]!.createdAt
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
      const storagePath = getProjectStoragePath(this.workspaceRoot);
      const files = await fs.readdir(storagePath, { withFileTypes: true });
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
    const filePath = getSessionFilePath(this.workspaceRoot, sessionId);
    const store = new JSONLStore(filePath);
    return store.readAll();
  }

  private applyPartToMessage(params: {
    part: PartInfo;
    record: MessageRecord;
    toolCalls: Map<string, SessionToolCallState>;
    subagentRefs: SessionSubagentRef[];
    summaryMessageIds: Set<string>;
    onSummary: (summary: string) => void;
  }): void {
    const {
      part,
      record,
      toolCalls,
      subagentRefs,
      summaryMessageIds,
      onSummary,
    } = params;

    switch (part.partType) {
      case 'text': {
        const payload = isRecord(part.payload) ? part.payload : {};
        record.message.content = typeof payload.text === 'string' ? payload.text : '';
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
        const toolName =
          typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const output = cloneJsonValue(payload.output as JsonValue);
        const error =
          typeof payload.error === 'string' ? payload.error : undefined;

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
          record.message.metadata = cloneJsonValue(payload.metadata as JsonValue);
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
