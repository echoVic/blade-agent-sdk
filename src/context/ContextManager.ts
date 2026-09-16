import { nanoid } from 'nanoid';
import { ConfigError } from '../errors/ConfigError.js';
import type { ConversationMessage } from '../model/conversation.js';
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
import type { SessionState } from '../session/SessionStore.js';
import type { PersistedPendingInput } from '../session/transcript.js';
import {
  type InputId,
  MessageId,
  type RequestId,
  SessionId,
  type ToolUseId,
} from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { ContextCompressor } from './processors/ContextCompressor.js';
import { CacheStore } from './storage/CacheStore.js';
import { MemoryStore } from './storage/MemoryStore.js';
import type {
  ContextData,
  ContextManagerOptions,
  ContextMessage,
  ContextToolCall,
  SystemContext,
  WorkspaceContext,
} from './types.js';

type SessionConfiguration = JsonObject & { sessionId?: SessionId };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsageMetadata(value: unknown): value is { input_tokens: number; output_tokens: number } {
  return (
    isJsonObject(value) &&
    typeof value.input_tokens === 'number' &&
    typeof value.output_tokens === 'number'
  );
}

/**
 * 上下文管理器 - 统一管理所有上下文相关操作
 */
export class ContextManager {
  private readonly memory: MemoryStore;
  private readonly repository: SessionRepository;
  private readonly eventStore: SessionEventStore;
  private readonly cache: CacheStore;
  private readonly compressor: ContextCompressor;
  private readonly options: ContextManagerOptions;
  private readonly projectPath?: string;

  private currentSessionId: SessionId | null = null;
  private readonly pendingToolUses = new Map<string, MessageId[]>();
  private initialized = false;

  constructor(
    options: Partial<ContextManagerOptions> = {},
    repository?: SessionRepository,
    eventStore?: SessionEventStore,
  ) {
    const persistenceEnabled = options.storage?.persistenceEnabled ?? true;
    const compatibleEventStore = eventStore;
    if (
      persistenceEnabled &&
      ((repository && !compatibleEventStore) || (!repository && compatibleEventStore))
    ) {
      throw new ConfigError(
        'Persistent context requires both SessionRepository and SessionEventStore.',
      );
    }
    const noopRepository = new NoopSessionRepository();
    // 持久化路径必须由调用方显式提供；未提供时禁用持久化
    const defaultPersistentPath = persistenceEnabled ? options.storage?.persistentPath : undefined;

    this.options = {
      storage: {
        maxMemorySize: 1000,
        persistentPath: defaultPersistentPath,
        persistenceEnabled,
        cacheSize: 100,
        compressionEnabled: true,
        ...options.storage,
      },
      defaultFilter: {
        maxTokens: 32000,
        maxMessages: 50,
        timeWindow: 24 * 60 * 60 * 1000,
        ...options.defaultFilter,
      },
      compressionThreshold: options.compressionThreshold || 6000,
      enableVectorSearch: options.enableVectorSearch || false,
      projectPath: options.projectPath,
    };
    this.projectPath = this.options.projectPath;

    // Session selects explicit read projection and event append ports.
    this.memory = new MemoryStore(this.options.storage.maxMemorySize);
    this.repository = persistenceEnabled && repository ? repository : noopRepository;
    this.eventStore =
      persistenceEnabled && compatibleEventStore ? compatibleEventStore : noopRepository;
    this.cache = new CacheStore(
      this.options.storage.cacheSize,
      5 * 60 * 1000, // 5分钟默认TTL
    );

    // 初始化处理器
    this.compressor = new ContextCompressor();
  }

  /**
   * 初始化上下文管理器
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      if (!this.options.storage.persistenceEnabled) {
        this.initialized = true;
        console.log('上下文管理器初始化完成');
        return;
      }

      await this.repository.initialize();

      // 检查存储健康状态
      const health = await this.repository.checkStorageHealth();
      if (!health.isAvailable) {
        console.warn('警告：持久化存储不可用，将仅使用内存存储');
      }

      this.initialized = true;
      console.log('上下文管理器初始化完成');
    } catch (error) {
      console.error('上下文管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 创建新会话
   */
  async createSession(
    userId?: string,
    preferences: JsonObject = {},
    configuration: SessionConfiguration = {},
  ): Promise<SessionId> {
    // 优先使用配置中的sessionId，否则生成新的
    const sessionId = configuration.sessionId || this.generateSessionId();
    const now = Date.now();

    // 创建初始上下文数据
    const contextData: ContextData = {
      layers: {
        system: await this.createSystemContext(),
        session: {
          sessionId,
          userId,
          preferences,
          configuration,
          startTime: now,
        },
        conversation: {
          messages: [],
          topics: [],
          lastActivity: now,
        },
        tool: {
          recentCalls: [],
          toolStates: {},
          dependencies: {},
        },
        workspace: await this.createWorkspaceContext(),
      },
      metadata: {
        totalTokens: 0,
        priority: 1,
        lastUpdated: now,
      },
    };

    // 初始化内存并写入首个 session_created 事件
    this.memory.setContext(contextData);
    await this.eventStore.createSession(sessionId);

    this.currentSessionId = sessionId;

    console.log(`新会话已创建: ${sessionId}`);
    return sessionId;
  }

  /**
   * 加载现有会话
   */
  async loadSession(sessionId: SessionId): Promise<boolean> {
    // 先尝试从内存加载
    let contextData = this.memory.getContext();

    if (!contextData || contextData.layers.session.sessionId !== sessionId) {
      const state = await this.repository.loadState(sessionId);
      if (!state) {
        return false;
      }

      contextData = await this.buildContextDataFromState(state);
      this.memory.setContext(contextData);
    }

    this.currentSessionId = sessionId;
    console.log(`会话已加载: ${sessionId}`);
    return true;
  }

  /**
   * 添加消息到当前会话
   */
  async addMessage(
    role: ContextMessage['role'],
    content: ModelMessage['content'],
    metadata?: JsonObject,
  ): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    const messageId = await this.eventStore.saveMessage(
      this.currentSessionId,
      role,
      content,
      null,
      metadata
        ? {
            model: typeof metadata.model === 'string' ? metadata.model : undefined,
            usage: isUsageMetadata(metadata.usage) ? metadata.usage : undefined,
          }
        : undefined,
    );

    const message: ContextMessage = {
      id: messageId,
      role,
      content: this.stringifyMessageContent(content),
      timestamp: Date.now(),
      metadata,
    };

    this.memory.addMessage(message);

    // 如果需要压缩，执行压缩
    const contextData = this.memory.getContext();
    if (contextData && this.shouldCompress(contextData)) {
      await this.compressCurrentContext();
    }
  }

  /**
   * 添加工具调用记录
   */
  async addToolCall(toolCall: ContextToolCall): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    const pendingToolUseKey = `${this.currentSessionId}\0${toolCall.id}`;
    if (toolCall.status === 'pending') {
      const persisted = await this.eventStore.saveToolUse(
        this.currentSessionId,
        toolCall.name,
        toolCall.input,
        null,
        undefined,
        toolCall.id,
      );
      const pendingMessageIds = this.pendingToolUses.get(pendingToolUseKey) ?? [];
      pendingMessageIds.push(persisted.messageId);
      this.pendingToolUses.set(pendingToolUseKey, pendingMessageIds);
    } else {
      const pendingMessageIds = this.pendingToolUses.get(pendingToolUseKey) ?? [];
      const parentMessageId = pendingMessageIds.shift() ?? null;
      if (pendingMessageIds.length > 0) {
        this.pendingToolUses.set(pendingToolUseKey, pendingMessageIds);
      } else {
        this.pendingToolUses.delete(pendingToolUseKey);
      }
      await this.eventStore.saveToolResult(
        this.currentSessionId,
        toolCall.id,
        toolCall.name,
        toolCall.output ?? null,
        parentMessageId,
        toolCall.error,
      );
    }

    this.memory.addToolCall(toolCall);
  }

  /**
   * Record that a message write failed, so the transcript now has a gap.
   *
   * The record is committed before the request continues: a client that reconnects
   * must not be handed a cursor past content that never reached the transcript. The
   * Request is recorded with it so repair can rebuild that Request's history rather
   * than whichever request is active when repair happens to run.
   */
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
      // The gap itself is real either way; a failed marker must not break the turn.
      console.warn('[ContextManager] 记录历史写入缺口失败:', error);
    }
  }

  /** 保存消息到 repository，不依赖 currentSessionId。 */
  async saveMessage(
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

  async saveInputEnqueued(sessionId: SessionId, input: PersistedPendingInput): Promise<void> {
    return this.eventStore.saveInputEnqueued(sessionId, input);
  }

  async saveAppliedInputMessage(
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

  async saveInputCancelled(sessionId: SessionId, inputId: InputId, reason: string): Promise<void> {
    return this.eventStore.saveInputCancelled(sessionId, inputId, reason);
  }

  /** 保存工具调用到 repository。 */
  async saveToolUse(
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

  /** 保存工具结果到 repository。 */
  async saveToolResult(
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

  /** 保存压缩边界和总结到 repository。 */
  async saveCompaction(
    sessionId: SessionId,
    summary: string,
    metadata: SessionRepositoryCompactionMetadata,
    parentMessageId: MessageId | null = null,
  ): Promise<MessageId> {
    return this.eventStore.saveCompaction(sessionId, summary, metadata, parentMessageId);
  }

  /**
   * 更新工具状态
   */
  updateToolState(toolName: string, state: JsonValue): void {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    this.memory.updateToolState(toolName, state);
  }

  /**
   * 更新工作空间信息
   */
  updateWorkspace(updates: Partial<WorkspaceContext>): void {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    this.memory.updateWorkspace(updates);
  }

  /**
   * 获取管理器统计信息
   */
  async getStats(): Promise<{
    currentSession: string | null;
    memory: ReturnType<MemoryStore['getMemoryInfo']>;
    cache: ReturnType<CacheStore['getStats']>;
    storage: Awaited<ReturnType<SessionRepository['getStorageStats']>>;
  }> {
    const [memoryInfo, cacheStats, storageStats] = await Promise.all([
      Promise.resolve(this.memory.getMemoryInfo()),
      Promise.resolve(this.cache.getStats()),
      this.repository.getStorageStats(),
    ]);

    return {
      currentSession: this.currentSessionId,
      memory: memoryInfo,
      cache: cacheStats,
      storage: storageStats,
    };
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.currentSessionId) {
      await this.saveCurrentSession();
    }

    this.memory.clear();
    this.cache.clear();
    await this.repository.cleanupOldSessions();

    this.currentSessionId = null;
    console.log('上下文管理器资源清理完成');
  }

  // 私有方法

  private generateSessionId(): SessionId {
    return SessionId(nanoid());
  }

  private async createSystemContext(): Promise<SystemContext> {
    return {
      role: 'AI助手',
      capabilities: ['对话', '工具调用', '代码生成', '文档分析'],
      tools: ['文件操作', 'Git操作', '代码分析'],
      version: '1.0.0',
    };
  }

  private async createWorkspaceContext(): Promise<WorkspaceContext> {
    try {
      const cwd = this.projectPath;
      return {
        ...(cwd ? { projectPath: cwd } : {}),
        currentFiles: [],
        recentFiles: [],
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          ...(cwd ? { cwd } : {}),
        },
      };
    } catch (_error) {
      return {
        currentFiles: [],
        recentFiles: [],
        environment: {},
      };
    }
  }

  private shouldCompress(contextData: ContextData): boolean {
    return contextData.metadata.totalTokens > this.options.compressionThreshold;
  }

  private async compressCurrentContext(): Promise<void> {
    const contextData = this.memory.getContext();
    if (!contextData) return;

    const compressed = await this.compressor.compress(contextData);

    // 更新对话摘要
    contextData.layers.conversation.summary = compressed.summary;

    this.memory.setContext(contextData);
  }

  private async saveCurrentSession(): Promise<void> {
    return Promise.resolve();
  }

  private async buildContextDataFromState(state: SessionState): Promise<ContextData> {
    return {
      layers: {
        system: await this.createSystemContext(),
        session: {
          sessionId: state.sessionId,
          userId: undefined,
          preferences: {},
          configuration: {},
          startTime: state.createdAt,
        },
        conversation: {
          messages: state.timeline.map((entry) =>
            this.toContextMessage(entry.message, entry.createdAt),
          ),
          summary: state.summary,
          topics: [],
          lastActivity: state.lastActivity,
        },
        tool: {
          recentCalls: state.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            output: toolCall.output,
            timestamp: toolCall.timestamp,
            status: toolCall.status,
            error: toolCall.error,
          })),
          toolStates: {},
          dependencies: {},
        },
        workspace: await this.createWorkspaceContext(),
      },
      metadata: {
        totalTokens: 0,
        priority: 1,
        lastUpdated: state.lastActivity,
      },
    };
  }

  private toContextMessage(message: ConversationMessage, createdAt: number): ContextMessage {
    return {
      id: MessageId(message.id ?? nanoid()),
      role: message.role,
      content: this.stringifyMessageContent(message.content),
      timestamp: createdAt,
      metadata: message.extensions,
    };
  }

  private stringifyMessageContent(content: ModelMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (part.type === 'text') {
          return part.text;
        }
        return '[image]';
      })
      .join('\n');
  }
}
