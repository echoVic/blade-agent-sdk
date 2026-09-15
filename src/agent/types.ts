/**
 * Agent核心类型定义
 */

import type { OutputFormat } from '../model/config.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { AgentMiddlewareConfig } from '../middleware/AgentPlugin.js';
import type { ContextSnapshot } from '../runtime/index.js';
import type { SandboxSettings } from '../sandbox/config.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import type { DurableExecutionFence } from '../session/events/DurableExecutionLeaseStore.js';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type { ConfirmationHandler, ToolExecutionLifecycle } from '../tools/types/execution.js';
import type { PermissionMode } from '../types/constants.js';
import type { AgentId, InputId, RequestId, SessionId } from '../types/identifiers.js';
import type { CanUseTool, PermissionHandler, PermissionsConfig } from '../types/permissions.js';
import type { AgentRunControl, AgentSteeringInput } from './AgentRunControl.js';
import type { InitialInputPreparation } from './InitialInputPreparation.js';
import type { ModelExecutionLifecycle } from './ModelExecutionLifecycle.js';
import type { AgentSession } from './subagents/AgentSessionStore.js';
import type { StartBackgroundAgentOptions } from './subagents/BackgroundAgentManager.js';
import type { TokenBudgetConfig, TokenBudgetSnapshot } from './TokenBudget.js';
import type { UserMessageContent } from './UserMessageContent.js';

export type { UserMessageContent } from './UserMessageContent.js';

export interface InputApplicationLifecycle {
  onInputApplying(input: Pick<AgentSteeringInput, 'inputId' | 'priority'>): Promise<void>;
}

/**
 * 后台 Agent 管理器的最小接口
 *
 * 解耦 state/types 层对 subagents 具体实现的依赖。
 * BackgroundAgentManager 通过 structural typing 隐式满足此接口。
 *
 * 分层设计：
 * - IBackgroundAgentReader: 读取/查询能力（TaskOutput 使用）
 * - IBackgroundAgentController: 启动/停止/恢复能力（Task 使用）
 * - IBackgroundAgentManager: 完整接口（SessionRuntime 注入）
 */

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: string;
  summary?: string;
  updatedAt: number;
}

export interface IBackgroundAgentReader {
  /**
   * Subagent state lives behind a storage capability that may be remote, so this
   * reader cannot be synchronous.
   */
  getAgent(agentId: AgentId): Promise<AgentSession | undefined>;
  getOwnerSessionId?(): SessionId | undefined;
  isRunning(agentId: AgentId): boolean;
  waitForCompletion(agentId: AgentId, timeout?: number): Promise<AgentSession | undefined>;
}

export interface IBackgroundAgentController {
  killAgent(agentId: AgentId): Promise<boolean>;
  cancelCurrentWork(agentId: AgentId): boolean;
  startBackgroundAgent(options: StartBackgroundAgentOptions): Promise<string>;
  resumeAgent(agentId: AgentId, newPrompt: string, ...args: unknown[]): Promise<string | undefined>;
  sendMessage(agentId: AgentId, message: string): boolean;
}

export interface IBackgroundAgentManager
  extends IBackgroundAgentReader,
    IBackgroundAgentController {
  getMiddleware?(): AgentMiddlewareConfig;
  getProviderRegistry?(): ProviderRegistry | undefined;
}

/**
 * 子代理信息（用于 JSONL 写入）
 */
interface SubagentInfoForContext {
  parentSessionId: SessionId;
  subagentType: string;
  isSidechain: boolean;
}

/** Mutable conversation data owned by one Agent execution. */
export interface AgentConversationState {
  messages: ConversationMessage[];
  userId: string;
  sessionId: SessionId;
  snapshot?: ContextSnapshot;
}

/** Cancellation, permission, and fencing controls for one Agent execution. */
export interface AgentExecutionControl {
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  executionFence?: DurableExecutionFence;
  /** Validates execution ownership immediately before a model or tool side effect. */
  assertExecutionLease?: () => Promise<void>;
  /** Serializes a short persistence operation against lease takeover. */
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Optional runtime services that are not part of conversation data or control. */
export interface AgentExecutionServices {
  systemPrompt?: string;
  subagentInfo?: SubagentInfoForContext;
  omitEnvironment?: boolean;
  backgroundAgentManager?: IBackgroundAgentManager;
}

/**
 * Internal execution context. The runtime object stays flat while ownership is
 * expressed by the three narrow contracts above.
 */
export type AgentExecutionContext = AgentConversationState &
  AgentExecutionControl &
  AgentExecutionServices;

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export interface AgentRuntimeOptions {
  // 运行时参数
  systemPrompt?: string; // 完全替换系统提示
  appendSystemPrompt?: string; // 追加系统提示
  permissions?: Partial<PermissionsConfig>; // 运行时覆盖权限
  permissionMode?: PermissionMode;
  maxTurns?: number; // 最大对话轮次 (-1=无限制, 0=禁用对话, N>0=限制轮次)
  toolWhitelist?: string[]; // 工具白名单（仅允许指定工具）
  toolSourcePolicy?: ToolCatalogSourcePolicy; // 工具来源/信任级别过滤
  modelId?: string;

  // 权限控制
  /** Full permission callback. Takes precedence when canUseTool is also provided. */
  permissionHandler?: PermissionHandler;
  /** Legacy permission callback, used only when permissionHandler is absent. */
  canUseTool?: CanUseTool;

  // MCP 配置
  mcpConfig?: string[]; // CLI 参数：MCP 配置文件路径或 JSON 字符串数组
  strictMcpConfig?: boolean; // CLI 参数：严格模式，仅使用 --mcp-config 指定的配置

  // 结构化输出
  outputFormat?: OutputFormat; // JSON Schema 结构化输出格式

  // 沙箱配置
  sandbox?: SandboxSettings; // 命令执行沙箱设置

  // Token 预算
  tokenBudget?: TokenBudgetConfig;

  /** @internal Enables filesystem-backed skills, attachments, and agent discovery. */
  localDiscovery?: boolean;
}

// ===== Agentic Loop Types =====

export interface LoopOptions {
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  /** @internal Durable queued-input application metadata. */
  inputApplication?: {
    inputId: InputId;
    requestId: RequestId;
  };
  /** @internal Applies the same attachment and skill preparation as initial input. */
  prepareInput?: (input: UserMessageContent) => Promise<UserMessageContent>;
  /** @internal Session-owned input and cancellation control plane. */
  runControl?: AgentRunControl;
  /** @internal Session-owned durable tool lifecycle recorder. */
  toolExecutionLifecycle?: ToolExecutionLifecycle;
  /** @internal Persists a steering input before its preparation side effects. */
  inputApplicationLifecycle?: InputApplicationLifecycle;
  /** @internal Persists model invocation boundaries for durable recovery. */
  modelExecutionLifecycle?: ModelExecutionLifecycle;
  /** @internal A recovered Request already completed its initial input preparation. */
  initialInputPreparation?: InitialInputPreparation;
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
  /** 进度回调，每次 tool call 完成后触发 */
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
}

/**
 * 轮次限制响应
 */
export interface TurnLimitResponse {
  continue: boolean;
  reason?: string;
}

export interface LoopResult {
  success: boolean;
  finalMessage?: string;
  error?: {
    type:
      | 'canceled'
      | 'max_turns_exceeded'
      | 'api_error'
      | 'loop_detected'
      | 'aborted'
      | 'chat_disabled'
      | 'budget_exhausted';
    message: string;
    details?: unknown;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed?: number; // Token 使用量
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
    shouldExitLoop?: boolean; // ExitPlanMode 或用户拒绝时设置此标记以退出循环
    targetMode?: PermissionMode; // Plan 模式批准后的目标权限模式
    planContent?: string; // Plan 模式批准后的方案内容
    tokenBudgetSnapshot?: TokenBudgetSnapshot;
  };
}

/** Plan 审批通过后的 LoopResult 子类型 */
export interface PlanApprovalResult extends LoopResult {
  metadata: LoopResult['metadata'] & {
    targetMode: PermissionMode;
    planContent?: string;
  };
}

export function isPlanApprovalResult(r: LoopResult | undefined): r is PlanApprovalResult {
  return !!r?.metadata?.targetMode;
}
