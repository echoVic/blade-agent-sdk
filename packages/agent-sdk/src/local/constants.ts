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
