import type {
  MessageId,
  ModelAttemptId,
  PermissionRequestId,
  SessionId,
  ToolUseId,
} from '@/types/identifiers.js';
import type { BladeConfig } from '../../agent/config.js';
import type { IBackgroundAgentManager } from '../../agent/types.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import type { PermissionMode } from '../../types/constants.js';
import type { JsonObject } from '../../types/json.js';
import type { ToolCatalog } from '../catalog/index.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { ToolKind, ToolSideEffect } from './kind.js';
import type { ToolResult } from './result.js';

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
  type?: 'permission' | 'enterPlanMode' | 'exitPlanMode' | 'maxTurnsExceeded' | 'askUserQuestion'; // 确认类型
  /** Durable correlation ID when the request is journaled. */
  permissionRequestId?: PermissionRequestId;
  /** Aborted when the owning request no longer accepts this confirmation. */
  abortSignal?: AbortSignal;
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

export interface ToolPermissionResolution {
  permissionRequestId: PermissionRequestId;
  decision: 'allow' | 'deny' | 'cancel';
  message?: string;
}

export interface ToolExecutionStartedLifecycle {
  input: JsonObject;
  sideEffect: ToolSideEffect;
}

export interface ToolInvocationLifecycle {
  onPermissionRequested?(
    details: ConfirmationDetails,
    input: JsonObject,
  ): Promise<PermissionRequestId>;
  onPermissionResolved?(resolution: ToolPermissionResolution): Promise<void>;
  onExecutionStarted?(event: ToolExecutionStartedLifecycle): Promise<void>;
}

export interface ToolScheduledLifecycle {
  toolCallId: ToolUseId;
  toolName: string;
  modelAttemptId?: ModelAttemptId;
  modelInput: JsonObject;
  input: JsonObject;
  sideEffect: ToolSideEffect;
  interruptBehavior: 'block' | 'cancel';
}

export interface ToolSettledLifecycle {
  toolCallId: ToolUseId;
  toolName: string;
  result: ToolResult;
}

export interface ToolExecutionLifecycle {
  onToolScheduled?(event: ToolScheduledLifecycle): Promise<ToolInvocationLifecycle | undefined>;
  onToolSettled?(event: ToolSettledLifecycle): Promise<void>;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  userId?: string;
  sessionId?: SessionId;
  messageId?: MessageId;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  executionFence?: DurableExecutionFence;
  /** @internal Validates execution ownership immediately before a side effect. */
  assertExecutionLease?: () => Promise<void>;
  /** @internal Serializes a short persistence operation against lease takeover. */
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
  discoveredTools?: string[];
  /** @internal Awaited lifecycle boundary immediately before the tool side effect. */
  toolInvocationLifecycle?: ToolInvocationLifecycle;
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
