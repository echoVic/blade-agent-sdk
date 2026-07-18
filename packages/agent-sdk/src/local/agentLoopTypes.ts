/**
 * Agent loop type definitions
 */
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { ToolCatalogSourcePolicy } from '../tools/public-index.js';
import type { AgentId, SessionId } from './branded.js';
import type { OutputFormat, PermissionMode, PermissionsConfig, SandboxSettings } from '../types/common.js';
import type { CanUseTool, PermissionHandler } from '../types/permissions.js';
import type { TokenBudgetConfig, TokenBudgetSnapshot } from '@blade-ai/agent/budget';
import type { AgentProgress, TurnLimitResponse } from './agentTypes.js';

/**
 * Agent 创建选项 - 仅包含运行时参数
 * Agent 的配置来自 Store (通过 getConfig() 获取 BladeConfig)
 */
export interface AgentOptions {
  // 运行时参数
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissions?: Partial<PermissionsConfig>;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  toolWhitelist?: string[];
  toolSourcePolicy?: ToolCatalogSourcePolicy;
  modelId?: string;

  // 权限控制
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;

  // MCP 配置
  mcpConfig?: string[];
  strictMcpConfig?: boolean;

  // 结构化输出
  outputFormat?: OutputFormat;

  // 沙箱配置
  sandbox?: SandboxSettings;

  // Token 预算
  tokenBudget?: TokenBudgetConfig;
}

export interface LoopOptions {
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
  /** 进度回调，每次 tool call 完成后触发 */
  onProgress?: (progress: AgentProgress) => void;
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
    tokensUsed?: number;
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
    shouldExitLoop?: boolean;
    targetMode?: PermissionMode;
    planContent?: string;
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
