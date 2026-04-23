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
  PLAN: 'plan',
} as const;

export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const HookEvent = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PermissionRequest: 'PermissionRequest',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  TaskCompleted: 'TaskCompleted',
  Notification: 'Notification',
  Compaction: 'Compaction',
  StopFailure: 'StopFailure',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  Elicitation: 'Elicitation',
  ElicitationResult: 'ElicitationResult',
  ConfigChange: 'ConfigChange',
  CwdChanged: 'CwdChanged',
  FileChanged: 'FileChanged',
  InstructionsLoaded: 'InstructionsLoaded',
} as const;

export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

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
  TOOL_PROGRESS: 'tool_progress',
  TOOL_MESSAGE: 'tool_message',
  TOOL_RUNTIME_PATCH: 'tool_runtime_patch',
  TOOL_CONTEXT_PATCH: 'tool_context_patch',
  TOOL_NEW_MESSAGES: 'tool_new_messages',
  TOOL_PERMISSION_UPDATES: 'tool_permission_updates',
  TOOL_RESULT: 'tool_result',
  USAGE: 'usage',
  RESULT: 'result',
  ERROR: 'error',
} as const;

export type StreamMessageType = (typeof StreamMessageType)[keyof typeof StreamMessageType];

export const PermissionDecision = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
} as const;

export type PermissionDecision = (typeof PermissionDecision)[keyof typeof PermissionDecision];
