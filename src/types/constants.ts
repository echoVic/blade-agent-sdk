/**
 * 类型安全常量定义
 *
 * 使用 `as const` 对象模式替代 enum，提供：
 * 1. 编译时类型检查
 * 2. IDE 自动补全
 * 3. 更好的 tree-shaking
 * 4. 运行时可枚举
 */

export const PermissionMode = {
  DEFAULT: 'default',
  AUTO_EDIT: 'autoEdit',
  YOLO: 'yolo',
  BYPASSALL: 'bypassAll',
  PLAN: 'plan',
  SPEC: 'spec',
} as const;

export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export enum HookEvent {
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  PostToolUseFailure = 'PostToolUseFailure',
  PermissionRequest = 'PermissionRequest',
  UserPromptSubmit = 'UserPromptSubmit',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
  Stop = 'Stop',
  SubagentStart = 'SubagentStart',
  SubagentStop = 'SubagentStop',
  TaskCompleted = 'TaskCompleted',
  Notification = 'Notification',
  Compaction = 'Compaction',
}

export const MessageRole = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
} as const;

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const StreamMessageType = {
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  CONTENT: 'content',
  THINKING: 'thinking',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  USAGE: 'usage',
  RESULT: 'result',
  ERROR: 'error',
} as const;

export type StreamMessageType = (typeof StreamMessageType)[keyof typeof StreamMessageType];

export const ToolKind = {
  READONLY: 'readonly',
  WRITE: 'write',
  EXECUTE: 'execute',
} as const;

export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

export const PermissionBehavior = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
} as const;

export type PermissionBehavior = (typeof PermissionBehavior)[keyof typeof PermissionBehavior];

export const DecisionBehavior = {
  APPROVE: 'approve',
  BLOCK: 'block',
  ASYNC: 'async',
} as const;

export type DecisionBehavior = (typeof DecisionBehavior)[keyof typeof DecisionBehavior];

export const PermissionDecision = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
} as const;

export type PermissionDecision = (typeof PermissionDecision)[keyof typeof PermissionDecision];

export const HookType = {
  COMMAND: 'command',
  PROMPT: 'prompt',
} as const;

export type HookType = (typeof HookType)[keyof typeof HookType];

export const HookExitCode = {
  SUCCESS: 0,
  NON_BLOCKING_ERROR: 1,
  BLOCKING_ERROR: 2,
  TIMEOUT: 124,
} as const;

export type HookExitCode = (typeof HookExitCode)[keyof typeof HookExitCode];

export const ToolErrorType = {
  VALIDATION_ERROR: 'validation_error',
  PERMISSION_DENIED: 'permission_denied',
  EXECUTION_ERROR: 'execution_error',
  TIMEOUT_ERROR: 'timeout_error',
  NETWORK_ERROR: 'network_error',
} as const;

export type ToolErrorType = (typeof ToolErrorType)[keyof typeof ToolErrorType];
