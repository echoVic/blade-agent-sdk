import type { IBackgroundAgentManager } from '../../agent/types.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { BladeConfig, JsonObject, PermissionMode } from '../../types/common.js';
import type { ToolCatalog } from '../catalog/index.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { ToolKind, ToolResult } from './ToolTypes.js';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface ConfirmationDetails {
  type?:
    | 'permission'
    | 'enterPlanMode'
    | 'exitPlanMode'
    | 'maxTurnsExceeded'
    | 'askUserQuestion'; // 确认类型
  kind?: ToolKind; // 工具类型（readonly, write, execute），用于权限模式判断
  toolName?: string;
  args?: JsonObject;
  title?: string;
  message: string;
  details?: string; // 🆕 Plan 方案内容或其他详细信息
  risks?: string[];
  affectedFiles?: string[];
  planContent?: string; // Plan 模式的完整计划内容（Markdown 格式）
  questions?: Question[]; // 🆕 AskUserQuestion 的问题列表
}

type PermissionApprovalScope = 'once' | 'session';

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  scope?: PermissionApprovalScope;
  targetMode?: PermissionMode; // Plan 模式退出后的目标权限模式
  feedback?: string; // 🆕 用户拒绝时的反馈意见（用于 Plan 模式调整）
  answers?: Record<string, string | string[]>; // 🆕 AskUserQuestion 的用户答案
}

/**
 * 确认处理器接口
 * 由 UI 层实现,用于处理需要用户确认的工具调用
 */
export interface ConfirmationHandler {
  /**
   * 请求用户确认
   * @param details 确认详情
   * @returns Promise<ConfirmationResponse> 用户的确认结果
   */
  requestConfirmation(details: ConfirmationDetails): Promise<ConfirmationResponse>;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  userId?: string;
  sessionId?: string;
  messageId?: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
  updateOutput?: (output: string) => void | Promise<void>;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
  discoveredTools?: string[];
}

export function getEffectiveProjectDir(context: ExecutionContext): string | undefined {
  return context.contextSnapshot?.cwd;
}

/**
 * 执行历史记录
 */
export interface ExecutionHistoryEntry {
  executionId: string;
  toolName: string;
  params: JsonObject;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}
