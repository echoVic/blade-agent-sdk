/**
 * Agent 会话持久化存储
 *
 * 用于支持 Task 工具的 resume 功能：
 * - 保存 agent 执行上下文到文件
 * - 支持跨会话恢复 agent
 * - 自动清理过期会话
 */

import fs from 'node:fs';
import path from 'node:path';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { Message } from '../../services/ChatServiceInterface.js';

/**
 * Agent 会话状态
 */
export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Agent 会话数据
 */
export interface AgentSession {
  /** 会话 ID (agent_{uuid}) */
  id: string;

  /** Subagent 类型 */
  subagentType: string;

  /** 任务描述 */
  description: string;

  /** 原始 prompt */
  prompt: string;

  /** 会话消息历史 */
  messages: Message[];

  /** 会话状态 */
  status: AgentSessionStatus;

  /** 最终结果（如果已完成） */
  result?: {
    success: boolean;
    message: string;
    error?: string;
  };

  /** 执行统计 */
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };

  /** 创建时间 */
  createdAt: number;

  /** 最后活跃时间 */
  lastActiveAt: number;

  /** 完成时间（如果已完成） */
  completedAt?: number;

  /** 父会话 ID（可选） */
  parentSessionId?: string;
}

/**
 * Agent 会话存储管理器
 *
 * 存储位置: {storageRoot}/agents/sessions/{agent_id}.json
 * storageRoot 通过 configure() 注入，未配置时降级为内存模式。
 */
export class AgentSessionStore {
  private static instance: AgentSessionStore | null = null;
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.AGENT);
  private sessionsDir: string | undefined;

  // 内存缓存（避免频繁读取文件）
  private cache = new Map<string, AgentSession>();

  private constructor(storageRoot?: string) {
    if (storageRoot) {
      this.sessionsDir = path.join(storageRoot, 'agents', 'sessions');
      this.ensureDirectory();
    }
  }

  static getInstance(logger?: InternalLogger): AgentSessionStore {
    if (!AgentSessionStore.instance) {
      AgentSessionStore.instance = new AgentSessionStore();
    }
    if (logger) {
      AgentSessionStore.instance.setLogger(logger);
    }
    return AgentSessionStore.instance;
  }

  /**
   * 配置持久化存储根目录（在首次 getInstance() 之前调用）
   */
  static configure(storageRoot: string): void {
    if (AgentSessionStore.instance) {
      // 实例已创建，更新 sessionsDir
      AgentSessionStore.instance.sessionsDir = path.join(storageRoot, 'agents', 'sessions');
      AgentSessionStore.instance.ensureDirectory();
    } else {
      // 预先配置，下次 getInstance() 时使用
      AgentSessionStore.instance = new AgentSessionStore(storageRoot);
    }
  }

  /**
   * 重置单例（用于测试）
   */
  static resetInstance(): void {
    AgentSessionStore.instance = null;
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
  }

  /**
   * 确保存储目录存在
   */
  private ensureDirectory(): void {
    if (!this.sessionsDir) return;
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(agentId: string): string | undefined {
    if (!this.sessionsDir) return undefined;
    // 安全处理 ID，避免路径遍历
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  /**
   * 保存会话
   */
  saveSession(session: AgentSession): void {
    // 更新缓存
    this.cache.set(session.id, session);

    const filePath = this.getSessionPath(session.id);
    if (!filePath) return;

    try {
      const data = JSON.stringify(session, null, 2);
      fs.writeFileSync(filePath, data, 'utf-8');
      this.logger.debug(`Session saved: ${session.id}`);
    } catch (error) {
      this.logger.warn(`Failed to save session ${session.id}:`, error);
    }
  }

  /**
   * 加载会话
   */
  loadSession(agentId: string): AgentSession | undefined {
    // 先检查缓存
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId);
    }

    const filePath = this.getSessionPath(agentId);
    if (!filePath) return undefined;

    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(data) as AgentSession;

      // 更新缓存
      this.cache.set(agentId, session);

      return session;
    } catch (error) {
      this.logger.warn(`Failed to load session ${agentId}:`, error);
      return undefined;
    }
  }

  /**
   * 更新会话状态
   */
  updateSession(
    agentId: string,
    updates: Partial<AgentSession>
  ): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    const updatedSession: AgentSession = {
      ...session,
      ...updates,
      lastActiveAt: Date.now(),
    };

    this.saveSession(updatedSession);
    return updatedSession;
  }

  /**
   * 追加消息到会话
   */
  appendMessages(agentId: string, messages: Message[]): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    return this.updateSession(agentId, {
      messages: [...session.messages, ...messages],
    });
  }

  /**
   * 标记会话完成
   */
  markCompleted(
    agentId: string,
    result: { success: boolean; message: string; error?: string },
    stats?: AgentSession['stats']
  ): AgentSession | undefined {
    return this.updateSession(agentId, {
      status: result.success ? 'completed' : 'failed',
      result,
      stats,
      completedAt: Date.now(),
    });
  }

  /**
   * 删除会话
   */
  deleteSession(agentId: string): boolean {
    try {
      const filePath = this.getSessionPath(agentId);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.cache.delete(agentId);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to delete session ${agentId}:`, error);
      return false;
    }
  }

  /**
   * 列出所有会话
   */
  listSessions(): AgentSession[] {
    // 内存模式：返回缓存中的所有会话
    if (!this.sessionsDir) {
      return Array.from(this.cache.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }

    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions: AgentSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const agentId = file.replace('.json', '');
        const session = this.loadSession(agentId);
        if (session) {
          sessions.push(session);
        }
      }

      // 按最后活跃时间倒序
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch (error) {
      this.logger.warn('Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * 列出运行中的会话
   */
  listRunningSessions(): AgentSession[] {
    return this.listSessions().filter((s) => s.status === 'running');
  }

  /**
   * 清理过期会话
   * @param maxAgeMs 最大保留时间（毫秒），默认 7 天
   */
  cleanupExpiredSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const sessions = this.listSessions();
    let cleaned = 0;

    for (const session of sessions) {
      // 只清理已完成的会话
      if (session.status === 'running') continue;

      const age = now - session.lastActiveAt;
      if (age > maxAgeMs) {
        if (this.deleteSession(session.id)) {
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} expired agent sessions`);
    }

    return cleaned;
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
