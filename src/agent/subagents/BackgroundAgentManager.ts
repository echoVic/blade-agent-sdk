/**
 * 后台 Agent 管理器
 *
 * 管理在后台运行的 subagent：
 * - 启动后台 agent
 * - 跟踪状态和输出
 * - 支持等待完成、恢复、终止
 */

import { nanoid } from 'nanoid';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { BladeConfig, PermissionMode } from '../../types/common.js';
import { Agent } from '../Agent.js';
import type { SubagentRegistry } from './SubagentRegistry.js';
import {
  type AgentSession,
  AgentSessionStore,
} from './AgentSessionStore.js';
import type { SubagentConfig, SubagentResult } from './types.js';

/**
 * 后台 Agent 运行时信息
 */
interface BackgroundAgentRuntime {
  /** Agent ID */
  id: string;

  /** 执行 Promise */
  promise: Promise<SubagentResult>;

  /** 终止整个后台 agent 生命周期 */
  lifecycleController: AbortController;

  /** 仅终止当前执行中的工作 */
  workController: AbortController;

  /** 开始时间 */
  startTime: number;
}

/**
 * 启动后台 Agent 的选项
 */
export interface StartBackgroundAgentOptions {
  /** Subagent 配置 */
  config: SubagentConfig;

  /** BladeConfig 配置 */
  bladeConfig: BladeConfig;

  /** 当前会话生效的 subagent 注册表 */
  subagentRegistry?: SubagentRegistry;

  /** 任务描述 */
  description: string;

  /** 任务 prompt */
  prompt: string;

  /** 父会话 ID */
  parentSessionId?: string;

  /** 权限模式 */
  permissionMode?: PermissionMode;

  /** 已有的 agent ID（用于 resume） */
  agentId?: string;

  /** 恢复时的初始消息（用于 resume） */
  existingMessages?: Message[];

  /** 父 turn 的 context snapshot（如果存在则继承） */
  snapshot?: ContextSnapshot;
}

/**
 * 后台 Agent 管理器
 */
export class BackgroundAgentManager {
  private static instance: BackgroundAgentManager | null = null;
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.AGENT);

  // 运行中的 agent
  private runningAgents = new Map<string, BackgroundAgentRuntime>();

  // 会话存储
  private sessionStore = AgentSessionStore.getInstance();

  private constructor() {
    this.cleanupOrphanedSessions();
  }

  static getInstance(logger?: InternalLogger): BackgroundAgentManager {
    if (!BackgroundAgentManager.instance) {
      BackgroundAgentManager.instance = new BackgroundAgentManager();
    }
    if (logger) {
      BackgroundAgentManager.instance.setLogger(logger);
    }
    return BackgroundAgentManager.instance;
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
    this.sessionStore = AgentSessionStore.getInstance(this.logger);
  }

  private cleanupOrphanedSessions(): void {
    const sessions = this.sessionStore.listSessions();
    const now = Date.now();
    const maxOrphanAge = 30 * 60 * 1000;

    for (const session of sessions) {
      if (session.status === 'running') {
        const isInMemory = this.runningAgents.has(session.id);
        const age = now - session.lastActiveAt;

        if (!isInMemory || age > maxOrphanAge) {
          this.logger.warn(`Cleaning up orphaned agent session: ${session.id}`);
          this.sessionStore.updateSession(session.id, {
            status: 'failed',
            result: {
              success: false,
              message: '',
              error: 'Session was orphaned (process restart or timeout)',
            },
            completedAt: now,
          });
        }
      }
    }
  }

  /**
   * 启动后台 Agent
   * @returns agent ID
   */
  startBackgroundAgent(options: StartBackgroundAgentOptions): string {
    const {
      config,
      bladeConfig,
      subagentRegistry,
      description,
      prompt,
      parentSessionId,
      permissionMode,
      agentId,
      existingMessages,
      snapshot,
    } = options;

    // 生成或使用已有的 agent ID
    const id = agentId || nanoid();

    // 创建输出文件路径
    const outputFile = join(tmpdir(), `blade-agent-${id}.output`);

    // 拆分生命周期取消和当前工作取消
    const lifecycleController = new AbortController();
    const workController = new AbortController();
    lifecycleController.signal.addEventListener(
      'abort',
      () => {
        if (!workController.signal.aborted) {
          workController.abort(lifecycleController.signal.reason);
        }
      },
      { once: true },
    );

    // 创建会话记录
    const session: AgentSession = {
      id,
      subagentType: config.name,
      description,
      prompt,
      messages: existingMessages || [],
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentSessionId,
      outputFile,
    };

    // 保存会话
    this.sessionStore.saveSession(session);

    const startTime = Date.now();
    const promise = this.executeAgent(
      id,
      config,
      bladeConfig,
      subagentRegistry,
      prompt,
      parentSessionId,
      permissionMode,
      lifecycleController.signal,
      workController.signal,
      existingMessages,
      snapshot,
    );

    // 记录运行时信息
    this.runningAgents.set(id, {
      id,
      promise,
      lifecycleController,
      workController,
      startTime,
    });

    // 执行完成后清理
    promise.finally(() => {
      this.runningAgents.delete(id);
    });

    this.logger.info(`Background agent started: ${id} (${config.name})`);
    return id;
  }

  /**
   * 执行 Agent（内部方法）
   */
  private async executeAgent(
    agentId: string,
    config: SubagentConfig,
    bladeConfig: BladeConfig,
    subagentRegistry: SubagentRegistry | undefined,
    prompt: string,
    parentSessionId: string | undefined,
    permissionMode: PermissionMode | undefined,
    lifecycleSignal: AbortSignal,
    workSignal: AbortSignal,
    existingMessages?: Message[],
    snapshot?: ContextSnapshot,
  ): Promise<SubagentResult> {
    const startTime = Date.now();

    try {
      if (lifecycleSignal.aborted || workSignal.aborted) {
        throw new Error('Agent execution was cancelled');
      }

      const systemPrompt = config.systemPrompt || '';
      const modelId =
        config.model && config.model !== 'inherit' ? config.model : undefined;
      const agent = await Agent.create(bladeConfig, {
        systemPrompt,
        toolWhitelist: config.tools,
        modelId,
      }, {
        subagentRegistry,
        // Background subagents should inherit the parent runtime context when a
        // snapshot exists. Without a snapshot, default to an empty context so
        // out-of-band background work does not gain implicit host access.
        defaultContext: snapshot
          ? snapshot.context
          : {},
      });

      const context = {
        messages: existingMessages || [],
        userId: 'subagent',
        sessionId: agentId,
        snapshot,
        permissionMode,
        subagentInfo: {
          parentSessionId: parentSessionId || '',
          subagentType: config.name,
          // Background agents run in a separate session tree; mark as sidechain
          // so their messages are not written into the parent session's store.
          isSidechain: true,
        },
      };

      const loopResult = await agent.runAgenticLoop(prompt, context, {
        signal: workSignal,
      });

      this.sessionStore.updateSession(agentId, {
        messages: context.messages,
      });

      const duration = Date.now() - startTime;
      const result: SubagentResult = loopResult.success
        ? {
            success: true,
            message: loopResult.finalMessage || '',
            agentId,
            stats: {
              tokens: loopResult.metadata?.tokensUsed || 0,
              toolCalls: loopResult.metadata?.toolCallsCount || 0,
              duration,
            },
          }
        : {
            success: false,
            message: '',
            agentId,
            error: loopResult.error?.message || 'Unknown error',
            stats: { duration },
          };

      this.sessionStore.markCompleted(
        agentId,
        {
          success: result.success,
          message: result.message,
          error: result.error,
        },
        result.stats
      );

      // Write output to file for streaming access
      const session = this.sessionStore.loadSession(agentId);
      if (session?.outputFile) {
        const output = JSON.stringify({ status: result.success ? 'completed' : 'failed', result }, null, 2);
        await writeFile(session.outputFile, output, 'utf-8').catch(() => {/* ignore write errors */});
      }

      this.logger.info(`Background agent completed: ${agentId} (success=${result.success})`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.sessionStore.markCompleted(
        agentId,
        {
          success: false,
          message: '',
          error: errorMessage,
        },
        { duration }
      );

      this.logger.warn(`Background agent failed: ${agentId}`, error);

      return {
        success: false,
        message: '',
        agentId,
        error: errorMessage,
        stats: { duration },
      };
    }
  }

  /**
   * 获取 Agent 状态
   */
  getAgent(agentId: string): AgentSession | undefined {
    return this.sessionStore.loadSession(agentId);
  }

  /**
   * 检查 Agent 是否正在运行
   */
  isRunning(agentId: string): boolean {
    return this.runningAgents.has(agentId);
  }

  /**
   * 等待 Agent 完成
   * @param agentId Agent ID
   * @param timeout 超时时间（毫秒），0 表示无限等待
   * @returns Agent 会话，如果超时返回 undefined
   */
  async waitForCompletion(
    agentId: string,
    timeout: number = 30000
  ): Promise<AgentSession | undefined> {
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      // 不在运行中，直接返回会话
      return this.sessionStore.loadSession(agentId);
    }

    // 等待执行完成或超时
    if (timeout > 0) {
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), timeout)
      );

      const result = await Promise.race([runtime.promise, timeoutPromise]);

      if (result === 'timeout') {
        // 返回当前状态（仍在运行）
        return this.sessionStore.loadSession(agentId);
      }
    } else {
      // 无限等待
      await runtime.promise;
    }

    // 返回最终状态
    return this.sessionStore.loadSession(agentId);
  }

  /**
   * 恢复 Agent（用于 resume 功能）
   * @param agentId 要恢复的 agent ID
   * @param newPrompt 新的 prompt
   * @param config Subagent 配置
   * @param bladeConfig BladeConfig 配置
   * @returns 新的 agent ID（如果创建了新 agent）或原 ID（如果继续执行）
   */
  resumeAgent(
    agentId: string,
    newPrompt: string,
    config: SubagentConfig,
    bladeConfig: BladeConfig,
    parentSessionId?: string,
    permissionMode?: PermissionMode,
    subagentRegistry?: SubagentRegistry,
    description?: string,
  ): string | undefined {
    const session = this.sessionStore.loadSession(agentId);

    if (!session) {
      this.logger.warn(`Cannot resume agent ${agentId}: session not found`);
      return undefined;
    }

    if (this.isRunning(agentId)) {
      this.logger.warn(`Cannot resume agent ${agentId}: still running`);
      return undefined;
    }

    return this.startBackgroundAgent({
      config,
      bladeConfig,
      subagentRegistry,
      description: description ?? session.description,
      prompt: newPrompt,
      parentSessionId: parentSessionId || session.parentSessionId,
      permissionMode,
      agentId,
      existingMessages: session.messages,
    });
  }

  /**
   * 取消/终止 Agent
   */
  killAgent(agentId: string): boolean {
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      // 不在运行中
      const session = this.sessionStore.loadSession(agentId);
      if (session && session.status === 'running') {
        // 更新状态为已取消
        this.sessionStore.updateSession(agentId, { status: 'cancelled' });
      }
      return false;
    }

    // 发送取消信号
    runtime.lifecycleController.abort();

    // 更新状态
    this.sessionStore.updateSession(agentId, { status: 'cancelled' });

    this.logger.info(`Background agent cancelled: ${agentId}`);
    return true;
  }

  /**
   * 列出所有后台 Agent
   */
  listAll(): AgentSession[] {
    return this.sessionStore.listSessions();
  }

  /**
   * 列出运行中的 Agent
   */
  listRunning(): AgentSession[] {
    return this.sessionStore.listRunningSessions();
  }

  /**
   * 获取运行中 Agent 的数量
   */
  getRunningCount(): number {
    return this.runningAgents.size;
  }

  /**
   * 终止所有运行中的 Agent
   */
  killAll(): void {
    for (const [agentId] of this.runningAgents) {
      this.killAgent(agentId);
    }
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAgeMs?: number): number {
    return this.sessionStore.cleanupExpiredSessions(maxAgeMs);
  }
}
