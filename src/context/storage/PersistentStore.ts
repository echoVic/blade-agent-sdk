import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { JsonlSessionStore } from '../../session/SessionStore.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import type { JsonObject, JsonValue, MessageRole } from '../../types/common.js';
import type {
  ContextData,
  ConversationContext,
  MessageInfo,
  PartInfo,
  SessionContext,
  SessionEvent,
  SessionInfo,
} from '../types.js';
import { JSONLStore } from './JSONLStore.js';
import {
  detectGitBranch,
  getSessionFilePathFromStorageRoot,
  listProjectDirectories,
  normalizeSessionStorageRoot
} from './pathUtils.js';

function extractMimeType(url: string): string | undefined {
  // data: URLs — extract the declared MIME type
  const dataMatch = /^data:([^;,]+)[;,]/.exec(url);
  if (dataMatch) {
    return dataMatch[1];
  }

  // Remote URLs — attempt to infer MIME type from file extension
  const extMatch = /\.(\w+)(?:[?#]|$)/.exec(url);
  if (extMatch) {
    const ext = (extMatch[1] ?? '').toLowerCase();
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
    };
    if (mimeMap[ext]) {
      return mimeMap[ext];
    }
  }

  return undefined;
}

/**
 * 持久化存储实现 - JSONL 格式
 * 存储路径: {storageRoot}/projects/{escaped-path}/{sessionId}.jsonl
 */
export class PersistentStore {
  private readonly storageRoot: string;
  private readonly projectPath?: string;
  private readonly maxSessions: number;
  private readonly version: string;

  constructor(
    storageRoot: string,
    maxSessions: number = 100,
    version: string = '0.0.10',
    projectPath?: string,
  ) {
    this.storageRoot = normalizeSessionStorageRoot(storageRoot);
    this.projectPath = projectPath;
    this.maxSessions = maxSessions;
    this.version = version;
  }

  private createEvent<T extends SessionEvent['type']>(
    type: T,
    sessionId: string,
    data: Extract<SessionEvent, { type: T }>['data']
  ): SessionEvent {
    return {
      id: nanoid(),
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      ...(this.projectPath ? { cwd: this.projectPath } : {}),
      ...(this.projectPath ? { gitBranch: detectGitBranch(this.projectPath) } : {}),
      version: this.version,
      data,
    } as SessionEvent;
  }

  private async ensureSessionCreated(
    sessionId: string,
    subagentInfo?: { parentSessionId: string; subagentType: string; isSidechain: boolean }
  ): Promise<void> {
    const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
    const store = new JSONLStore(filePath);
    const stats = await store.getStats();
    if (stats.lineCount > 0) return;
    const now = new Date().toISOString();
    const sessionInfo: SessionInfo = {
      sessionId,
      rootId: subagentInfo?.parentSessionId ?? sessionId,
      parentId: subagentInfo?.parentSessionId,
      relationType: subagentInfo ? 'subagent' : undefined,
      title: undefined,
      status: 'running',
      agentType: subagentInfo?.subagentType,
      model: undefined,
      permission: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const entry = this.createEvent('session_created', sessionId, sessionInfo);
    await store.append(entry);
  }

  private buildCompactionMetadata(metadata: {
    trigger: 'auto' | 'manual';
    preTokens: number;
    postTokens?: number;
    filesIncluded?: string[];
  }): JsonValue {
    const result: Record<string, JsonValue> = {
      trigger: metadata.trigger,
      preTokens: metadata.preTokens,
    };
    if (metadata.postTokens !== undefined) result.postTokens = metadata.postTokens;
    if (metadata.filesIncluded) result.filesIncluded = metadata.filesIncluded;
    result._systemSource = 'compaction_summary';
    return result;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    try {
      const storagePath = this.storageRoot;
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });
      console.log(`[PersistentStore] 初始化存储目录: ${storagePath}`);
    } catch (error) {
      console.warn('[PersistentStore] 无法创建持久化存储目录:', error);
    }
  }

  async createSession(
    sessionId: string,
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId, subagentInfo);
  }

  /**
   * 保存消息到 JSONL 文件（追加模式）
   */
  async saveMessage(
    sessionId: string,
    messageRole: MessageRole,
    content: string | ContentPart[],
    parentUuid: string | null = null,
    metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
      customMetadata?: JsonObject;
    },
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: messageRole,
        parentMessageId: parentUuid ?? undefined,
        createdAt: now,
        model: metadata?.model,
        usage: metadata?.usage,
        customMetadata: metadata?.customMetadata,
      };
      const messageEntry = this.createEvent('message_created', sessionId, messageInfo);
      const partEntries = this.buildPartEntries(sessionId, messageId, content, now);
      await store.appendBatch([messageEntry, ...partEntries]);
      return messageId;
    } catch (error) {
      console.error(`[PersistentStore] 保存消息失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存工具调用到 JSONL 文件
   */
  async saveToolUse(
    sessionId: string,
    toolName: string,
    toolInput: JsonValue,
    parentUuid: string | null = null,
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolCallId = nanoid();
      const partInfo: PartInfo = {
        partId: toolCallId,
        messageId,
        partType: 'tool_call',
        payload: { toolCallId, toolName, input: toolInput },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, partInfo));
      if (toolName === 'Task' && toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
        const subtaskInput = toolInput;
        const childSessionId =
          typeof subtaskInput.subagent_session_id === 'string'
            ? subtaskInput.subagent_session_id
            : undefined;
        const agentType =
          typeof subtaskInput.subagent_type === 'string'
            ? subtaskInput.subagent_type
            : undefined;
        if (childSessionId && agentType) {
          const subtaskPart: PartInfo = {
            partId: nanoid(),
            messageId,
            partType: 'subtask_ref',
            payload: {
              childSessionId,
              agentType,
              status: 'running',
              summary:
                typeof subtaskInput.description === 'string'
                  ? subtaskInput.description
                  : '',
              startedAt: now,
            },
            createdAt: now,
          };
          entries.push(this.createEvent('part_created', sessionId, subtaskPart));
        }
      }
      await store.appendBatch(entries);
      return toolCallId;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具调用失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存工具结果到 JSONL 文件
   */
  async saveToolResult(
    sessionId: string,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string,
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
    subagentRef?: {
      subagentSessionId: string;
      subagentType: string;
      subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
      subagentSummary?: string;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolResultPart: PartInfo = {
        partId: toolId,
        messageId,
        partType: 'tool_result',
        payload: { toolCallId: toolId, toolName, output: toolOutput, error: error ?? null },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, toolResultPart));
      if (subagentRef) {
        const finishedAt =
          subagentRef.subagentStatus === 'running' ? null : now;
        const subtaskPart: PartInfo = {
          partId: nanoid(),
          messageId,
          partType: 'subtask_ref',
          payload: {
            childSessionId: subagentRef.subagentSessionId,
            agentType: subagentRef.subagentType,
            status: subagentRef.subagentStatus,
            summary: subagentRef.subagentSummary ?? '',
            startedAt: now,
            finishedAt,
          },
          createdAt: now,
        };
        entries.push(this.createEvent('part_created', sessionId, subtaskPart));
      }
      await store.appendBatch(entries);
      return toolId;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具结果失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存压缩边界和总结消息到 JSONL
   * 用于上下文压缩功能
   *
   * @param sessionId 会话 ID
   * @param summary 压缩总结内容
   * @param metadata 压缩元数据（触发方式、token 数量、包含的文件等）
   * @param parentUuid 最后一条保留消息的 UUID（用于建立消息链）
   * @returns 总结消息的 UUID
   */
  async saveCompaction(
    sessionId: string,
    summary: string,
    metadata: {
      trigger: 'auto' | 'manual';
      preTokens: number;
      postTokens?: number;
      filesIncluded?: string[];
    },
    parentUuid: string | null = null
  ): Promise<string> {
    try {
      const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: 'system',
        parentMessageId: parentUuid ?? undefined,
        createdAt: now,
      };
      const compactMetadata = this.buildCompactionMetadata(metadata);
      const partInfo: PartInfo = {
        partId: nanoid(),
        messageId,
        partType: 'summary',
        payload: { text: summary, metadata: compactMetadata },
        createdAt: now,
      };
      const entries = [
        this.createEvent('message_created', sessionId, messageInfo),
        this.createEvent('part_created', sessionId, partInfo),
      ];
      await store.appendBatch(entries);
      return messageId;
    } catch (error) {
      console.error(`[PersistentStore] 保存压缩失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存完整上下文数据（向后兼容方法）
   * 将 ContextData 转为 JSONL 格式保存
   */
  async saveContext(sessionId: string, contextData: ContextData): Promise<void> {
    try {
      await this.createSession(sessionId);
      const { conversation } = contextData.layers;
      for (const msg of conversation.messages) {
        await this.saveMessage(sessionId, msg.role, msg.content, null);
      }
    } catch (error) {
      console.warn(`[PersistentStore] 保存上下文失败 (session: ${sessionId}):`, error);
    }
  }

  /**
   * 保存会话上下文（向后兼容方法 - 已废弃）
   */
  async saveSession(sessionId: string, sessionContext: SessionContext): Promise<void> {
    console.warn('[PersistentStore] saveSession 方法已废弃，请使用 saveMessage');
  }

  /**
   * 保存对话上下文（向后兼容方法 - 已废弃）
   */
  async saveConversation(
    sessionId: string,
    conversation: ConversationContext
  ): Promise<void> {
    console.warn('[PersistentStore] saveConversation 方法已废弃，请使用 saveMessage');
  }

  /**
   * 加载会话上下文（从 JSONL 重建）
   */
  async loadSession(sessionId: string): Promise<SessionContext | null> {
    const state = await this.getSessionStore().loadState(sessionId);
    if (!state) {
      return null;
    }

    return {
      sessionId,
      userId: undefined,
      preferences: {},
      configuration: {},
      startTime: state.createdAt,
    };
  }

  /**
   * 加载对话上下文（从 JSONL 重建）
   */
  async loadConversation(sessionId: string): Promise<ConversationContext | null> {
    const state = await this.getSessionStore().loadState(sessionId);
    if (!state) {
      return null;
    }

    return {
      messages: state.timeline.map((entry) => ({
        id: entry.id,
        role: entry.message.role,
        content: typeof entry.message.content === 'string'
          ? entry.message.content
          : JSON.stringify(entry.message.content),
        timestamp: entry.createdAt,
      })),
      summary: state.summary,
      topics: [],
      lastActivity: state.lastActivity,
    };
  }

  /**
   * 获取所有会话列表
   */
  async listSessions(): Promise<string[]> {
    return this.getSessionStore().listSessions();
  }

  /**
   * 获取会话摘要信息
   */
  async getSessionSummary(sessionId: string): Promise<{
    sessionId: string;
    lastActivity: number;
    messageCount: number;
    topics: string[];
  } | null> {
    const summary = await this.getSessionStore().getSessionSummary(sessionId);
    if (!summary) {
      return null;
    }

    return {
      sessionId: summary.sessionId,
      lastActivity: summary.lastActivity,
      messageCount: summary.messageCount,
      topics: summary.topics,
    };
  }

  /**
   * 删除会话数据
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
      const store = new JSONLStore(filePath);
      await store.delete();
    } catch (error) {
      console.warn(`[PersistentStore] 删除会话失败 (session: ${sessionId}):`, error);
    }
  }

  /**
   * 清理旧会话（保持最近的N个会话）
   */
  async cleanupOldSessions(): Promise<void> {
    try {
      const sessions = await this.listSessions();
      if (sessions.length <= this.maxSessions) {
        return;
      }

      // 获取所有会话的摘要信息并按时间排序
      const sessionSummaries = await Promise.all(
        sessions.map((sessionId) => this.getSessionSummary(sessionId))
      );

      const validSummaries = sessionSummaries
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
        .sort((a, b) => b.lastActivity - a.lastActivity);

      // 删除最旧的会话
      const sessionsToDelete = validSummaries
        .slice(this.maxSessions)
        .map((summary) => summary.sessionId);

      await Promise.all(
        sessionsToDelete.map((sessionId) => this.deleteSession(sessionId))
      );

      console.log(`[PersistentStore] 已清理 ${sessionsToDelete.length} 个旧会话`);
    } catch (error) {
      console.error('[PersistentStore] 清理旧会话失败:', error);
    }
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number;
    projectPath?: string;
  }> {
    try {
      const sessions = await this.listSessions();
      let totalSize = 0;

      for (const sessionId of sessions) {
        const filePath = getSessionFilePathFromStorageRoot(this.storageRoot, sessionId);
        const store = new JSONLStore(filePath);
        const stats = await store.getStats();
        totalSize += stats.size;
      }

      return {
        totalSessions: sessions.length,
        totalSize,
        projectPath: this.projectPath,
      };
    } catch {
      return {
        totalSessions: 0,
        totalSize: 0,
        projectPath: this.projectPath,
      };
    }
  }

  /**
   * 检查存储健康状态
   */
  async checkStorageHealth(): Promise<{
    isAvailable: boolean;
    canWrite: boolean;
    error?: string;
  }> {
    try {
      const storagePath = this.storageRoot;

      // 尝试创建目录
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });

      // 尝试写入测试文件
      const testFile = path.join(storagePath, '.health-check');
      await fs.writeFile(testFile, 'test', 'utf-8');
      await fs.unlink(testFile);

      return {
        isAvailable: true,
        canWrite: true,
      };
    } catch (error) {
      return {
        isAvailable: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 获取所有项目列表
   */
  async listAllProjects(): Promise<string[]> {
    return listProjectDirectories(this.storageRoot);
  }

  private buildPartEntries(
    sessionId: string,
    messageId: string,
    content: string | ContentPart[],
    createdAt: string,
  ): SessionEvent[] {
    if (typeof content === 'string') {
      return [
        this.createEvent('part_created', sessionId, {
          partId: nanoid(),
          messageId,
          partType: 'text',
          payload: { text: content },
          createdAt,
        } satisfies PartInfo),
      ];
    }

    return content.map((part) => {
      if (part.type === 'text') {
        return this.createEvent('part_created', sessionId, {
          partId: nanoid(),
          messageId,
          partType: 'text',
          payload: {
            text: part.text,
            ...(part.providerOptions
              ? { providerOptions: part.providerOptions as JsonValue }
              : {}),
          },
          createdAt,
        } satisfies PartInfo);
      }

      const mimeType = extractMimeType(part.image_url.url);
      return this.createEvent('part_created', sessionId, {
        partId: nanoid(),
        messageId,
        partType: 'image',
        payload: {
          ...(mimeType !== undefined ? { mimeType } : {}),
          dataUrl: part.image_url.url,
        },
        createdAt,
      } satisfies PartInfo);
    });
  }

  private getSessionStore(): JsonlSessionStore {
    return new JsonlSessionStore(this.storageRoot);
  }
}

export class NoopPersistentStore {
  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  async createSession(
    _sessionId: string,
    _subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
  ): Promise<void> {
    return Promise.resolve();
  }

  async saveMessage(
    _sessionId: string,
    _messageRole: MessageRole,
    _content: string | ContentPart[],
    _parentUuid: string | null = null,
    _metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
      customMetadata?: JsonObject;
    },
    _subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
  ): Promise<string> {
    return nanoid();
  }

  async saveToolUse(
    _sessionId: string,
    _toolName: string,
    _toolInput: JsonValue,
    _parentUuid: string | null = null,
    _subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
  ): Promise<string> {
    return nanoid();
  }

  async saveToolResult(
    _sessionId: string,
    toolId: string,
    _toolName: string,
    _toolOutput: JsonValue,
    _parentUuid: string | null = null,
    _error?: string,
    _subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
    _subagentRef?: {
      subagentSessionId: string;
      subagentType: string;
      subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
      subagentSummary?: string;
    },
  ): Promise<string> {
    return toolId;
  }

  async saveCompaction(
    _sessionId: string,
    _summary: string,
    _metadata: {
      trigger: 'auto' | 'manual';
      preTokens: number;
      postTokens?: number;
      filesIncluded?: string[];
    },
    _parentUuid: string | null = null,
  ): Promise<string> {
    return nanoid();
  }

  async saveContext(_sessionId: string, _contextData: ContextData): Promise<void> {
    return Promise.resolve();
  }

  async saveSession(_sessionId: string, _sessionContext: SessionContext): Promise<void> {
    return Promise.resolve();
  }

  async saveConversation(
    _sessionId: string,
    _conversation: ConversationContext,
  ): Promise<void> {
    return Promise.resolve();
  }

  async loadSession(_sessionId: string): Promise<SessionContext | null> {
    return null;
  }

  async loadConversation(_sessionId: string): Promise<ConversationContext | null> {
    return null;
  }

  async listSessions(): Promise<string[]> {
    return [];
  }

  async getSessionSummary(_sessionId: string): Promise<{
    sessionId: string;
    lastActivity: number;
    messageCount: number;
    topics: string[];
  } | null> {
    return null;
  }

  async deleteSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  async cleanupOldSessions(): Promise<void> {
    return Promise.resolve();
  }

  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number;
    projectPath?: string;
  }> {
    return {
      totalSessions: 0,
      totalSize: 0,
    };
  }

  async checkStorageHealth(): Promise<{
    isAvailable: boolean;
    canWrite: boolean;
    error?: string;
  }> {
    return {
      isAvailable: false,
      canWrite: false,
      error: 'Session persistence is disabled',
    };
  }
}
