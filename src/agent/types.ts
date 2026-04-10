/**
 * Agent核心类型定义
 */

import type { ContextSnapshot } from '../runtime/index.js';
import type { ContentPart, Message } from '../services/ChatServiceInterface.js';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { OutputFormat, PermissionMode, PermissionsConfig, SandboxSettings } from '../types/common.js';
import type { CanUseTool, PermissionHandler } from '../types/permissions.js';
import type { TokenBudgetConfig, TokenBudgetSnapshot } from './TokenBudget.js';
import type { StartBackgroundAgentOptions } from './subagents/BackgroundAgentManager.js';

/**
 * 用户消息内容类型
 * 支持纯文本或多模态内容（文本 + 图片）
 */
export type UserMessageContent = string | ContentPart[];

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
  getAgent(agentId: string): object | undefined;
  isRunning(agentId: string): boolean;
  waitForCompletion(agentId: string, timeout?: number): Promise<object | undefined>;
}

export interface IBackgroundAgentController {
  killAgent(agentId: string): boolean;
  cancelCurrentWork(agentId: string): boolean;
  startBackgroundAgent(options: StartBackgroundAgentOptions): string;
  resumeAgent(agentId: string, newPrompt: string, ...args: unknown[]): string | undefined;
  sendMessage(agentId: string, message: string): boolean;
}

export interface IBackgroundAgentManager extends IBackgroundAgentReader, IBackgroundAgentController {}

/**
 * 子代理信息（用于 JSONL 写入）
 */
export interface SubagentInfoForContext {
  parentSessionId: string;
  subagentType: string;
  isSidechain: boolean;
}

/**
 * 聊天上下文接口
 *
 * 职责：保存会话相关的数据和状态
 * - 消息历史、会话标识、用户标识等数据
 * - 会话级别的 UI 交互处理器（如 confirmationHandler）
 *
 * 不包含：循环过程中的事件回调（这些应该放在 LoopOptions）
 */
export interface ChatContext {
  messages: Message[];
  userId: string;
  sessionId: string;
  snapshot?: ContextSnapshot;
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler; // 会话级别的确认处理器
  permissionMode?: PermissionMode; // 当前权限模式（用于 Plan 模式判断）
  systemPrompt?: string; // 动态传入的系统提示词（无状态设计）
  subagentInfo?: SubagentInfoForContext; // 子代理信息（用于 JSONL 写入）
  omitEnvironment?: boolean;
  backgroundAgentManager?: IBackgroundAgentManager;
}

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export interface AgentOptions {
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
  permissionHandler?: PermissionHandler;
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

}

// ===== Agentic Loop Types =====

export interface LoopOptions {
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
  /** 进度回调，每次 tool call 完成后触发 */
  onProgress?: (progress: AgentProgress) => void;
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
