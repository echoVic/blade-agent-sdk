import * as crypto from 'crypto';
import { nanoid } from 'nanoid';
import type { Message } from '../services/ChatServiceInterface.js';
import { JsonlSessionStore, type SessionState, type SessionStore, type SessionSummary } from '../session/SessionStore.js';
import type { JsonObject, JsonValue } from '../types/common.js';
import { ContextCompressor } from './processors/ContextCompressor.js';
import { ContextFilter } from './processors/ContextFilter.js';
import { CacheStore } from './storage/CacheStore.js';
import { MemoryStore } from './storage/MemoryStore.js';
import { PersistentStore } from './storage/PersistentStore.js';
import { getBladeStorageRoot } from './storage/pathUtils.js';
import type {
  CompressedContext,
  ContextData,
  ContextManagerOptions,
  ContextMessage,
  ContextFilter as FilterOptions,
  SystemContext,
  ToolCall,
  WorkspaceContext,
} from './types.js';

type SessionConfiguration = JsonObject & { sessionId?: string };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsageMetadata(
  value: unknown,
): value is { input_tokens: number; output_tokens: number } {
  return isJsonObject(value)
    && typeof value.input_tokens === 'number'
    && typeof value.output_tokens === 'number';
}

/**
 * 上下文管理器 - 统一管理所有上下文相关操作
 */
export class ContextManager {
  private readonly memory: MemoryStore;
  private readonly persistent: PersistentStore;
  private readonly sessionStore: SessionStore;
  private readonly cache: CacheStore;
  private readonly compressor: ContextCompressor;
  private readonly filter: ContextFilter;
  private readonly options: ContextManagerOptions;
  private readonly projectPath: string;

  private currentSessionId: string | null = null;
  private initialized = false;

  constructor(options: Partial<ContextManagerOptions> = {}) {
    // 默认使用 ~/.blade/ 作为存储根目录
    const defaultPersistentPath =
      options.storage?.persistentPath || getBladeStorageRoot();

    this.options = {
      storage: {
        maxMemorySize: 1000,
        persistentPath: defaultPersistentPath,
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
      projectPath: options.projectPath || process.cwd(),
    };
    this.projectPath = this.options.projectPath || process.cwd();

    // 初始化存储层
    this.memory = new MemoryStore(this.options.storage.maxMemorySize);
    this.persistent = new PersistentStore(this.projectPath, 100);
    this.sessionStore = new JsonlSessionStore(this.projectPath);
    this.cache = new CacheStore(
      this.options.storage.cacheSize,
      5 * 60 * 1000 // 5分钟默认TTL
    );

    // 初始化处理器
    this.compressor = new ContextCompressor();
    this.filter = new ContextFilter(this.options.defaultFilter);
  }

  /**
   * 初始化上下文管理器
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.persistent.initialize();

      // 检查存储健康状态
      const health = await this.persistent.checkStorageHealth();
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
    configuration: SessionConfiguration = {}
  ): Promise<string> {
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
    await this.persistent.createSession(sessionId);

    this.currentSessionId = sessionId;

    console.log(`新会话已创建: ${sessionId}`);
    return sessionId;
  }

  /**
   * 加载现有会话
   */
  async loadSession(sessionId: string): Promise<boolean> {
    try {
      // 先尝试从内存加载
      let contextData = this.memory.getContext();

      if (!contextData || contextData.layers.session.sessionId !== sessionId) {
        const state = await this.sessionStore.loadState(sessionId);
        if (!state) {
          return false;
        }

        contextData = await this.buildContextDataFromState(state);
        this.memory.setContext(contextData);
      }

      this.currentSessionId = sessionId;
      console.log(`会话已加载: ${sessionId}`);
      return true;
    } catch (error) {
      console.error('加载会话失败:', error);
      return false;
    }
  }

  /**
   * 添加消息到当前会话
   */
  async addMessage(
    role: ContextMessage['role'],
    content: string,
    metadata?: JsonObject
  ): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    const messageId = await this.persistent.saveMessage(
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
      content,
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
  async addToolCall(toolCall: ToolCall): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    if (toolCall.status === 'pending') {
      const toolUseId = await this.persistent.saveToolUse(
        this.currentSessionId,
        toolCall.name,
        toolCall.input,
        null,
      );
      toolCall = { ...toolCall, id: toolUseId };
    } else {
      await this.persistent.saveToolResult(
        this.currentSessionId,
        toolCall.id,
        toolCall.name,
        toolCall.output ?? null,
        toolCall.id,
        toolCall.error,
      );
    }

    this.memory.addToolCall(toolCall);

    // 缓存成功的工具调用结果
    if (toolCall.status === 'success' && toolCall.output) {
      this.cache.cacheToolResult(toolCall.name, toolCall.input, toolCall.output);
    }
  }

  /**
   * 保存消息到 JSONL (直接访问 PersistentStore,不依赖 currentSessionId)
   */
  async saveMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    parentUuid: string | null = null,
    metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    },
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ): Promise<string> {
    return this.persistent.saveMessage(
      sessionId,
      role,
      content,
      parentUuid,
      metadata,
      subagentInfo
    );
  }

  /**
   * 保存工具调用到 JSONL (直接访问 PersistentStore)
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
    return this.persistent.saveToolUse(
      sessionId,
      toolName,
      toolInput,
      parentUuid,
      subagentInfo
    );
  }

  /**
   * 保存工具结果到 JSONL (直接访问 PersistentStore)
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
    return this.persistent.saveToolResult(
      sessionId,
      toolId,
      toolName,
      toolOutput,
      parentUuid,
      error,
      subagentInfo,
      subagentRef
    );
  }

  /**
   * 保存压缩边界和总结到 JSONL (直接访问 PersistentStore)
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
    return this.persistent.saveCompaction(sessionId, summary, metadata, parentUuid);
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
   * 获取格式化的上下文用于 Prompt 构建
   */
  async getFormattedContext(filterOptions?: FilterOptions): Promise<{
    context: ContextData;
    compressed?: CompressedContext;
    tokenCount: number;
  }> {
    const contextData = this.memory.getContext();
    if (!contextData) {
      throw new Error('没有可用的上下文数据');
    }

    // 应用过滤器
    const filteredContext = this.filter.filter(contextData, filterOptions);

    // 检查是否需要压缩
    const shouldCompress = this.shouldCompress(filteredContext);
    let compressed: CompressedContext | undefined;

    if (shouldCompress) {
      // 尝试从缓存获取压缩结果
      const contextHash = this.hashContext(filteredContext);
      compressed = this.cache.getCompressedContext(contextHash) ?? undefined;

      if (!compressed) {
        compressed = await this.compressor.compress(filteredContext);
        this.cache.cacheCompressedContext(contextHash, compressed);
      }
    }

    return {
      context: filteredContext,
      compressed,
      tokenCount: compressed
        ? compressed.tokenCount
        : filteredContext.metadata.totalTokens,
    };
  }

  /**
   * 搜索历史会话
   */
  async searchSessions(
    query: string,
    limit: number = 10
  ): Promise<
    Array<{
      sessionId: string;
      summary: string;
      lastActivity: number;
      relevanceScore: number;
      }>
  > {
    const sessions = await this.sessionStore.listSessions();
    const results: Array<{
      sessionId: string;
      summary: string;
      lastActivity: number;
      relevanceScore: number;
    }> = [];

    for (const sessionId of sessions) {
      const summary = await this.sessionStore.getSessionSummary(sessionId);
      if (summary) {
        const relevanceScore = this.calculateSummaryRelevance(query, summary);
        if (relevanceScore > 0) {
          results.push({
            sessionId,
            summary: summary.summaryText
              ? `${summary.messageCount}条消息，摘要：${summary.summaryText}`
              : `${summary.messageCount}条消息`,
            lastActivity: summary.lastActivity,
            relevanceScore,
          });
        }
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  /**
   * 获取缓存的工具调用结果
   */
  getCachedToolResult(toolName: string, input: JsonValue): unknown | null {
    return this.cache.getToolResult(toolName, input);
  }

  /**
   * 获取管理器统计信息
   */
  async getStats(): Promise<{
    currentSession: string | null;
    memory: ReturnType<MemoryStore['getMemoryInfo']>;
    cache: ReturnType<CacheStore['getStats']>;
    storage: Awaited<ReturnType<PersistentStore['getStorageStats']>>;
  }> {
    const [memoryInfo, cacheStats, storageStats] = await Promise.all([
      Promise.resolve(this.memory.getMemoryInfo()),
      Promise.resolve(this.cache.getStats()),
      this.persistent.getStorageStats(),
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
    await this.persistent.cleanupOldSessions();

    this.currentSessionId = null;
    console.log('上下文管理器资源清理完成');
  }

  // 私有方法

  private generateSessionId(): string {
    // 使用 nanoid 生成会话 ID
    return nanoid();
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
        projectPath: cwd,
        currentFiles: [],
        recentFiles: [],
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          cwd,
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

  private hashContext(contextData: ContextData): string {
    const content = JSON.stringify({
      messageCount: contextData.layers.conversation.messages.length,
      lastMessage:
        contextData.layers.conversation.messages[
          contextData.layers.conversation.messages.length - 1
        ]?.id,
      toolCallCount: contextData.layers.tool.recentCalls.length,
    });

    return crypto.createHash('md5').update(content).digest('hex');
  }

  private calculateRelevance(query: string, topics: string[]): number {
    const queryLower = query.toLowerCase();
    let score = 0;

    for (const topic of topics) {
      if (
        queryLower.includes(topic.toLowerCase()) ||
        topic.toLowerCase().includes(queryLower)
      ) {
        score += 1;
      }
    }

    return score;
  }

  private calculateSummaryRelevance(query: string, summary: SessionSummary): number {
    const topicsScore = this.calculateRelevance(query, summary.topics);
    if (topicsScore > 0) {
      return topicsScore;
    }

    if (!summary.summaryText) {
      return 0;
    }

    return this.calculateRelevance(query, [summary.summaryText]);
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
          messages: state.timeline.map((entry) => this.toContextMessage(entry.message, entry.createdAt)),
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

  private toContextMessage(message: Message, createdAt: number): ContextMessage {
    return {
      id: message.id ?? nanoid(),
      role: message.role,
      content: this.stringifyMessageContent(message.content),
      timestamp: createdAt,
      metadata: isJsonObject(message.metadata) ? message.metadata : undefined,
    };
  }

  private stringifyMessageContent(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (part.type === 'text') {
          return part.text;
        }
        return part.image_url.url;
      })
      .join('\n');
  }
}
