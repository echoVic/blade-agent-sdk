/**
 * AgentEvent — 标准化 Agent 事件类型
 *
 * 所有消费者（CLI、Web UI、SDK）通过同一个事件流获取状态。
 *
 * 生命周期：
 *   agent_start → (turn_start → [content/thinking/tool events] → turn_end)* → agent_end
 */

import type { ToolCall } from '../services/ChatServiceInterface.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type { RuntimeContextPatch, RuntimePatch } from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { PermissionUpdate } from '../types/permissions.js';
import type { ToolResult } from '../tools/types/ToolTypes.js';
import type { TokenBudgetSnapshot } from './TokenBudget.js';

// ===== Token 使用信息 =====

export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
}

// ===== Agent 生命周期事件 =====

/** Agent 开始执行 */
export interface AgentStartEvent {
  type: 'agent_start';
}

/** Agent 执行结束 */
export interface AgentEndEvent {
  type: 'agent_end';
}

// ===== Turn 事件 =====

/** 新一轮开始 */
export interface TurnStartEvent {
  type: 'turn_start';
  turn: number;
  maxTurns: number;
}

/** 一轮结束 */
export interface TurnEndEvent {
  type: 'turn_end';
  turn: number;
  hasToolCalls: boolean;
}

/** 同一轮重试（反应式压缩等），不计入 turnsCount */
export interface TurnRetryEvent {
  type: 'turn_retry';
  turn: number;
  reason: 'reactive_compact';
}

// ===== 内容流事件 =====

/** 内容增量（流式） */
export interface ContentDeltaEvent {
  type: 'content_delta';
  delta: string;
}

/** 思考增量（流式） */
export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

/** 流式输出结束 */
export interface StreamEndEvent {
  type: 'stream_end';
}

/** 完整内容（非流式兼容） */
export interface ContentEvent {
  type: 'content';
  content: string;
}

/** 完整思考内容（非流式兼容） */
export interface ThinkingEvent {
  type: 'thinking';
  content: string;
}

// ===== 工具事件 =====

/** 工具开始执行 */
export interface ToolStartEvent {
  type: 'tool_start';
  toolCall: ToolCall;
  toolKind?: 'readonly' | 'write' | 'execute';
}

/** 工具执行结束 */
export interface ToolResultEvent {
  type: 'tool_result';
  toolCall: ToolCall;
  result: ToolResult;
}

/** 工具执行进度 */
export interface ToolProgressEvent {
  type: 'tool_progress';
  toolCall: ToolCall;
  message: string;
}

/** 工具输出消息更新 */
export interface ToolMessageEvent {
  type: 'tool_message';
  toolCall: ToolCall;
  message: string;
}

/** 工具运行时 patch 事件 */
export interface ToolRuntimePatchEvent {
  type: 'tool_runtime_patch';
  toolCall: ToolCall;
  patch: RuntimePatch;
}

/** 工具上下文 patch 事件 */
export interface ToolContextPatchEvent {
  type: 'tool_context_patch';
  toolCall: ToolCall;
  patch: RuntimeContextPatch;
}

/** 工具注入消息事件 */
export interface ToolNewMessagesEvent {
  type: 'tool_new_messages';
  toolCall: ToolCall;
  messages: Message[];
}

/** 工具权限更新事件 */
export interface ToolPermissionUpdatesEvent {
  type: 'tool_permission_updates';
  toolCall: ToolCall;
  updates: PermissionUpdate[];
}

// ===== 状态事件 =====

/** Token 使用量 */
export interface TokenUsageEvent {
  type: 'token_usage';
  usage: TokenUsageInfo;
}

/** Token 预算预警 */
export interface BudgetWarningEvent {
  type: 'budget_warning';
  snapshot: TokenBudgetSnapshot;
}

/** 上下文压缩状态 */
export interface CompactingEvent {
  type: 'compacting';
  isCompacting: boolean;
}

/** Todo 列表更新 */
export interface TodoUpdateEvent {
  type: 'todo_update';
  todos: TodoItem[];
}

/** API 重试事件 */
export interface ApiRetryEvent {
  type: 'api_retry';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: {
    status?: number;
    message: string;
  };
}

/** 模型 fallback 事件 */
export interface ModelFallbackEvent {
  type: 'model_fallback';
  originalModel: string;
  fallbackModel: string;
}

/** 错误事件 */
export interface ErrorEvent {
  type: 'error';
  message: string;
}

/** 恢复事件 */
export interface RecoveryEvent {
  type: 'recovery';
  phase: 'started' | 'retrying' | 'failed';
  reason: 'context_overflow' | 'reactive_compact' | 'recovery_exhausted';
}

// ===== 联合类型 =====

/**
 * 所有 Agent 事件的联合类型（单一事实来源）
 *
 * 生命周期事件：agent_start/agent_end/turn_start/turn_end
 * 内容流事件：content_delta/thinking_delta/stream_end/content/thinking
 * 工具事件：tool_start/tool_progress/tool_message/tool_runtime_patch/tool_context_patch/tool_new_messages/tool_permission_updates/tool_result
 * 状态事件：token_usage/compacting/todo_update/error
 */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | TurnRetryEvent
  | ContentDeltaEvent
  | ThinkingDeltaEvent
  | StreamEndEvent
  | ContentEvent
  | ThinkingEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolMessageEvent
  | ToolRuntimePatchEvent
  | ToolContextPatchEvent
  | ToolNewMessagesEvent
  | ToolPermissionUpdatesEvent
  | ToolResultEvent
  | TokenUsageEvent
  | BudgetWarningEvent
  | CompactingEvent
  | TodoUpdateEvent
  | ApiRetryEvent
  | ModelFallbackEvent
  | RecoveryEvent
  | ErrorEvent;
