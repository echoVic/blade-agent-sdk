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
import type { ToolResult } from '../tools/types/ToolTypes.js';

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

// ===== 状态事件 =====

/** Token 使用量 */
export interface TokenUsageEvent {
  type: 'token_usage';
  usage: TokenUsageInfo;
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

/** 错误事件 */
export interface ErrorEvent {
  type: 'error';
  message: string;
}

// ===== 联合类型 =====

/**
 * 所有 Agent 事件的联合类型（单一事实来源）
 *
 * 生命周期事件：agent_start/agent_end/turn_start/turn_end
 * 内容流事件：content_delta/thinking_delta/stream_end/content/thinking
 * 工具事件：tool_start/tool_result
 * 状态事件：token_usage/compacting/todo_update/error
 */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ContentDeltaEvent
  | ThinkingDeltaEvent
  | StreamEndEvent
  | ContentEvent
  | ThinkingEvent
  | ToolStartEvent
  | ToolResultEvent
  | TokenUsageEvent
  | CompactingEvent
  | TodoUpdateEvent
  | ErrorEvent;
