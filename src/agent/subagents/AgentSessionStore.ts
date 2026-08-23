/**
 * Agent 会话持久化存储
 *
 * 用于支持 Task 工具的 resume 功能：
 * - 保存 agent 执行上下文到文件
 * - 支持跨会话恢复 agent
 * - 自动清理过期会话
 */

import fs from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import { AgentId } from '../../types/branded.js';
import {
  syncParentDirectory,
  withAdvisoryFileLock,
} from '../../utils/advisoryFileLock.js';
import type { AgentProgress } from '../types.js';

const AGENT_SESSION_LOCK_TIMEOUT_MS = 10_000;

/**
 * Agent 会话状态
 */
export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Agent 会话数据
 */
export interface AgentSession {
  /** 会话 ID (agent_{uuid}) */
  id: AgentId;

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

  /** 输出文件路径（后台 agent 完成后写入结果） */
  outputFile?: string;

  /** 运行时进度（仅在 status === 'running' 时持续更新） */
  progress?: AgentProgress;

  /** Root Session ownership that is allowed to mutate this execution. */
  executionFence?: DurableExecutionFence;
}

/**
 * Agent 会话存储管理器
 *
 * 存储位置: {storageRoot}/agents/sessions/{agent_id}.json
 * storageRoot 通过 configure() 注入，未配置时降级为内存模式。
 */
export class AgentSessionStore {
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.AGENT);
  private sessionsDir: string | undefined;

  // 内存缓存（避免频繁读取文件）
  private cache = new Map<AgentId, AgentSession>();

  constructor(storageRoot?: string, logger?: InternalLogger) {
    if (storageRoot) {
      this.sessionsDir = path.join(storageRoot, 'agents', 'sessions');
      this.ensureDirectory();
    }
    if (logger) {
      this.logger = logger.child(LogCategory.AGENT);
    }
  }

  /**
   * 创建独立实例（推荐用于 per-runtime 场景）
   *
   * 与 getInstance() 不同，create() 返回的实例不共享全局状态，
   * 适合同进程多个 SessionRuntime 各自管理自己的 agent session。
   */
  static create(storageRoot?: string, logger?: InternalLogger): AgentSessionStore {
    return new AgentSessionStore(storageRoot, logger);
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
  private getSessionPath(agentId: AgentId): string | undefined {
    if (!this.sessionsDir) return undefined;
    // 安全处理 ID，避免路径遍历
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  /**
   * 保存会话
   */
  async saveSession(session: AgentSession): Promise<boolean> {
    return this.runWithSessionLock(session.id, 'write', async () => {
      const current = this.loadSessionFromDisk(session.id);
      if (
        current &&
        !this.canReplaceExecution(current.executionFence, session.executionFence)
      ) {
        return false;
      }

      await this.writeSession(session);
      return true;
    });
  }

  private async writeSession(session: AgentSession): Promise<void> {
    const filePath = this.getSessionPath(session.id);
    if (!filePath) {
      this.cache.set(session.id, session);
      return;
    }

    try {
      const data = JSON.stringify(session, null, 2);
      const created = !fs.existsSync(filePath);
      await writeFileAtomic(filePath, data, {
        encoding: 'utf8',
        fsync: true,
        mode: 0o600,
      });
      if (created) {
        await syncParentDirectory(filePath);
      }
      this.cache.set(session.id, session);
      this.logger.debug(`Session saved: ${session.id}`);
    } catch (error) {
      this.logger.warn(`Failed to save session ${session.id}:`, error);
      throw error;
    }
  }

  /**
   * 加载会话
   */
  loadSession(agentId: AgentId): AgentSession | undefined {
    if (!this.sessionsDir && this.cache.has(agentId)) {
      return this.cache.get(agentId);
    }

    return this.loadSessionFromDisk(agentId);
  }

  private loadSessionFromDisk(agentId: AgentId): AgentSession | undefined {
    const filePath = this.getSessionPath(agentId);
    if (!filePath) {
      return this.cache.get(agentId);
    }
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
  async updateSession(
    agentId: AgentId,
    updates: Partial<AgentSession>,
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.runWithSessionLock(agentId, 'write', async () => {
      const session = this.loadSessionFromDisk(agentId);
      if (
        !session ||
        !this.sameExecutionFence(session.executionFence, expectedExecutionFence)
      ) {
        return undefined;
      }

      const updatedSession: AgentSession = {
        ...session,
        ...updates,
        executionFence: session.executionFence,
        lastActiveAt: Date.now(),
      };

      await this.writeSession(updatedSession);
      return updatedSession;
    });
  }

  /**
   * 追加消息到会话
   */
  async appendMessages(
    agentId: AgentId,
    messages: Message[],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    return this.updateSession(agentId, {
      messages: [...session.messages, ...messages],
    }, expectedExecutionFence);
  }

  /**
   * 更新运行中会话的可变字段（消息、进度）。
   * 仅允许在 status === 'running' 时更新，避免终端状态后写入陈旧数据。
   */
  async updateRunningSession(
    agentId: AgentId,
    updates: { messages?: Message[]; progress?: AgentProgress },
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.runWithSessionLock(agentId, 'write', async () => {
      const session = this.loadSessionFromDisk(agentId);
      if (
        !session ||
        session.status !== 'running' ||
        !this.sameExecutionFence(session.executionFence, expectedExecutionFence)
      ) {
        return undefined;
      }
      const updatedSession: AgentSession = {
        ...session,
        ...updates,
        executionFence: session.executionFence,
        lastActiveAt: Date.now(),
      };
      await this.writeSession(updatedSession);
      return updatedSession;
    });
  }

  /**
   * 标记会话完成（成功或失败）。
   */
  async markCompleted(
    agentId: AgentId,
    result: { success: boolean; message: string; error?: string },
    stats?: AgentSession['stats'],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.updateSession(agentId, {
      status: result.success ? 'completed' : 'failed',
      result,
      stats,
      completedAt: Date.now(),
      progress: undefined,
    }, expectedExecutionFence);
  }

  /**
   * 标记会话已取消。
   */
  async markCancelled(
    agentId: AgentId,
    result?: { success: false; message: string; error?: string },
    stats?: AgentSession['stats'],
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<AgentSession | undefined> {
    return this.updateSession(agentId, {
      status: 'cancelled',
      result: result ?? { success: false, message: '' },
      stats,
      completedAt: Date.now(),
      progress: undefined,
    }, expectedExecutionFence);
  }

  /**
   * 删除会话
   */
  async deleteSession(
    agentId: AgentId,
    expectedExecutionFence?: DurableExecutionFence,
  ): Promise<boolean> {
    try {
      return await this.runWithSessionLock(agentId, 'write', async () => {
        const session = this.loadSessionFromDisk(agentId);
        if (
          session &&
          !this.sameExecutionFence(session.executionFence, expectedExecutionFence)
        ) {
          return false;
        }
        await this.deleteSessionFile(agentId);
        return true;
      });
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

        const agentId = AgentId(file.replace('.json', ''));
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
  async cleanupExpiredSessions(
    maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const now = Date.now();
    const sessions = this.listSessions();
    let cleaned = 0;

    for (const session of sessions) {
      // 只清理已完成的会话
      if (session.status === 'running') continue;

      const age = now - session.lastActiveAt;
      if (age > maxAgeMs) {
        if (await this.deleteTerminalSession(session.id)) {
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

  private async deleteTerminalSession(agentId: AgentId): Promise<boolean> {
    return this.runWithSessionLock(agentId, 'write', async () => {
      const session = this.loadSessionFromDisk(agentId);
      if (!session || session.status === 'running') {
        return false;
      }
      await this.deleteSessionFile(agentId);
      return true;
    });
  }

  private async deleteSessionFile(agentId: AgentId): Promise<void> {
    const filePath = this.getSessionPath(agentId);
    if (filePath) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        ) {
          throw error;
        }
      }
    }
    this.cache.delete(agentId);
  }

  private runWithSessionLock<T>(
    agentId: AgentId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
  ): Promise<T> {
    const filePath = this.getSessionPath(agentId);
    if (!filePath) {
      return callback();
    }
    return withAdvisoryFileLock(
      filePath,
      {
        timeoutMs: AGENT_SESSION_LOCK_TIMEOUT_MS,
        errors: {
          prepare: (cause) => this.storageError(agentId, operation, cause),
          initialize: (cause) => this.storageError(agentId, operation, cause),
          acquire: (cause) => this.storageError(agentId, operation, cause),
          timeout: () =>
            new Error(
              `Timed out acquiring the background agent ${operation} lock for ${agentId}`,
            ),
          release: (cause) => this.storageError(agentId, operation, cause),
        },
      },
      callback,
    );
  }

  private storageError(
    agentId: AgentId,
    operation: 'read' | 'write',
    cause: unknown,
  ): Error {
    return new Error(
      `Failed to ${operation} background agent session ${agentId}`,
      { cause },
    );
  }

  private canReplaceExecution(
    current: DurableExecutionFence | undefined,
    next: DurableExecutionFence | undefined,
  ): boolean {
    if (!current) {
      return true;
    }
    if (!next) {
      return false;
    }
    if (this.sameExecutionFence(current, next)) {
      return true;
    }
    return next.fencingToken > current.fencingToken;
  }

  private sameExecutionFence(
    left: DurableExecutionFence | undefined,
    right: DurableExecutionFence | undefined,
  ): boolean {
    if (!left || !right) {
      return left === right;
    }
    return (
      left.leaseId === right.leaseId &&
      left.fencingToken === right.fencingToken
    );
  }
}
