/**
 * Hook System Zod Schemas
 *
 * 用于验证 Hook 输入输出的 Zod Schema
 */

import { z } from 'zod';
import type { JsonValue } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import {
  DecisionBehavior,
  HookType,
  PermissionDecision,
} from '../types/HookTypes.js';

/**
 * Zod schema for recursive JSON values (string | number | boolean | null | JsonObject | JsonValue[])
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// ============================================================================
// Hook Input Schemas
// ============================================================================

const HookInputBaseSchema = z.object({
  hook_event_name: z.nativeEnum(HookEvent),
  hook_execution_id: z.string(),
  timestamp: z.string(),
  project_dir: z.string(),
  session_id: z.string(),
  permission_mode: z.enum(['default', 'autoEdit', 'yolo', 'plan']),
  _metadata: z
    .object({
      blade_version: z.string(),
      hook_timeout_ms: z.number(),
    })
    .optional(),
});

const PreToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PreToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), JsonValueSchema),
});

const PostToolUseInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostToolUse),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), JsonValueSchema),
  tool_response: z.unknown(),
});

const StopInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Stop),
  reason: z.string().optional(),
});

const PostToolUseFailureInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostToolUseFailure),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), JsonValueSchema),
  error: z.string(),
  error_type: z.string().optional(),
  is_interrupt: z.boolean(),
  is_timeout: z.boolean(),
});

const PermissionRequestInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PermissionRequest),
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), JsonValueSchema),
});

const UserPromptSubmitInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.UserPromptSubmit),
  user_prompt: z.string(),
  has_images: z.boolean(),
  image_count: z.number(),
});

const SessionStartInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SessionStart),
  is_resume: z.boolean(),
  resume_session_id: z.string().optional(),
});

const SessionEndInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SessionEnd),
  reason: z.enum([
    'user_exit',
    'error',
    'max_turns',
    'idle_timeout',
    'ctrl_c',
    'clear',
    'logout',
    'other',
  ]),
});

const SubagentStartInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SubagentStart),
  agent_type: z.string(),
  task_description: z.string().optional(),
  parent_agent_id: z.string().optional(),
});

const SubagentStopInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.SubagentStop),
  agent_type: z.string(),
  task_description: z.string().optional(),
  success: z.boolean(),
  result_summary: z.string().optional(),
  error: z.string().optional(),
});

const TaskCompletedInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.TaskCompleted),
  task_id: z.string(),
  task_description: z.string(),
  result_summary: z.string().optional(),
  success: z.boolean(),
});

const NotificationInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Notification),
  notification_type: z.enum([
    'permission_prompt',
    'idle_prompt',
    'auth_success',
    'elicitation_dialog',
    'info',
    'warning',
    'error',
  ]),
  title: z.string().optional(),
  message: z.string(),
});

const CompactionInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Compaction),
  trigger: z.enum(['manual', 'auto']),
  messages_before: z.number(),
  tokens_before: z.number(),
});

// ---------- New hook input schemas ----------

const StopFailureInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.StopFailure),
  reason: z.string(),
  error: z.string().optional(),
  tool_name: z.string().optional(),
});

const PreCompactInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PreCompact),
  trigger: z.enum(['manual', 'auto']),
  messages_before: z.number(),
  tokens_before: z.number(),
});

const PostCompactInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.PostCompact),
  trigger: z.enum(['manual', 'auto']),
  messages_before: z.number(),
  messages_after: z.number(),
  tokens_before: z.number(),
  tokens_after: z.number(),
  summary: z.string().optional(),
});

const ElicitationInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.Elicitation),
  server_name: z.string(),
  resource_uri: z.string().optional(),
  message: z.string().optional(),
});

const ElicitationResultInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.ElicitationResult),
  server_name: z.string(),
  response: z.string().optional(),
  was_cancelled: z.boolean(),
});

const ConfigChangeInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.ConfigChange),
  changed_keys: z.array(z.string()),
  source: z.enum(['file', 'command', 'environment']),
});

const CwdChangedInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.CwdChanged),
  old_cwd: z.string(),
  new_cwd: z.string(),
});

const FileChangedInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.FileChanged),
  file_path: z.string(),
  change_type: z.enum(['created', 'modified', 'deleted']),
});

const InstructionsLoadedInputSchema = HookInputBaseSchema.extend({
  hook_event_name: z.literal(HookEvent.InstructionsLoaded),
  source: z.string(),
  instructions_length: z.number(),
});

const _HookInputSchema = z.discriminatedUnion('hook_event_name', [
  PreToolUseInputSchema,
  PostToolUseInputSchema,
  StopInputSchema,
  PostToolUseFailureInputSchema,
  PermissionRequestInputSchema,
  UserPromptSubmitInputSchema,
  SessionStartInputSchema,
  SessionEndInputSchema,
  SubagentStartInputSchema,
  SubagentStopInputSchema,
  TaskCompletedInputSchema,
  NotificationInputSchema,
  CompactionInputSchema,
  // New hooks
  StopFailureInputSchema,
  PreCompactInputSchema,
  PostCompactInputSchema,
  ElicitationInputSchema,
  ElicitationResultInputSchema,
  ConfigChangeInputSchema,
  CwdChangedInputSchema,
  FileChangedInputSchema,
  InstructionsLoadedInputSchema,
]);

// ============================================================================
// Hook Output Schemas
// ============================================================================

const PreToolUseOutputSchema = z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: z.nativeEnum(PermissionDecision).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), JsonValueSchema).optional(),
});

const PostToolUseOutputSchema = z.object({
  hookEventName: z.literal('PostToolUse'),
  additionalContext: z.string().optional(),
  updatedOutput: JsonValueSchema.optional(),
});

const StopOutputSchema = z.object({
  hookEventName: z.literal('Stop'),
  continue: z.boolean().optional(),
  continueReason: z.string().optional(),
});

const SubagentStartOutputSchema = z.object({
  hookEventName: z.literal('SubagentStart'),
  additionalContext: z.string().optional(),
});

const SubagentStopOutputSchema = z.object({
  hookEventName: z.literal('SubagentStop'),
  continue: z.boolean().optional(),
  continueReason: z.string().optional(),
  additionalContext: z.string().optional(),
});

const TaskCompletedOutputSchema = z.object({
  hookEventName: z.literal('TaskCompleted'),
  blockCompletion: z.boolean().optional(),
  blockReason: z.string().optional(),
});

const PermissionRequestOutputSchema = z.object({
  hookEventName: z.literal('PermissionRequest'),
  permissionDecision: z.enum(['approve', 'deny', 'ask']).optional(),
  permissionDecisionReason: z.string().optional(),
});

const UserPromptSubmitOutputSchema = z.object({
  hookEventName: z.literal('UserPromptSubmit'),
  updatedPrompt: z.string().optional(),
  contextInjection: z.string().optional(),
});

const SessionStartOutputSchema = z.object({
  hookEventName: z.literal('SessionStart'),
  env: z.record(z.string()).optional(),
});

const CompactionOutputSchema = z.object({
  hookEventName: z.literal('Compaction'),
  blockCompaction: z.boolean().optional(),
  blockReason: z.string().optional(),
});

// ---------- New hook output schemas ----------

const StopFailureOutputSchema = z.object({
  hookEventName: z.literal('StopFailure'),
  shouldRetry: z.boolean().optional(),
  retryReason: z.string().optional(),
});

const PreCompactOutputSchema = z.object({
  hookEventName: z.literal('PreCompact'),
  blockCompaction: z.boolean().optional(),
  blockReason: z.string().optional(),
});

const PostCompactOutputSchema = z.object({
  hookEventName: z.literal('PostCompact'),
  additionalContext: z.string().optional(),
});

const ElicitationOutputSchema = z.object({
  hookEventName: z.literal('Elicitation'),
  proceed: z.boolean().optional(),
  response: z.string().optional(),
});

const ElicitationResultOutputSchema = z.object({
  hookEventName: z.literal('ElicitationResult'),
  proceed: z.boolean().optional(),
});

const ConfigChangeOutputSchema = z.object({
  hookEventName: z.literal('ConfigChange'),
  proceed: z.boolean().optional(),
});

const CwdChangedOutputSchema = z.object({
  hookEventName: z.literal('CwdChanged'),
  proceed: z.boolean().optional(),
});

const FileChangedOutputSchema = z.object({
  hookEventName: z.literal('FileChanged'),
  action: z.enum(['reload', 'ignore']).optional(),
});

const InstructionsLoadedOutputSchema = z.object({
  hookEventName: z.literal('InstructionsLoaded'),
  proceed: z.boolean().optional(),
  modified_instructions: z.string().optional(),
});

const HookOutputSchema = z.object({
  decision: z
    .object({
      behavior: z.nativeEnum(DecisionBehavior),
    })
    .optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z
    .discriminatedUnion('hookEventName', [
      PreToolUseOutputSchema,
      PostToolUseOutputSchema,
      StopOutputSchema,
      SubagentStartOutputSchema,
      SubagentStopOutputSchema,
      TaskCompletedOutputSchema,
      PermissionRequestOutputSchema,
      UserPromptSubmitOutputSchema,
      SessionStartOutputSchema,
      CompactionOutputSchema,
      // New hooks
      StopFailureOutputSchema,
      PreCompactOutputSchema,
      PostCompactOutputSchema,
      ElicitationOutputSchema,
      ElicitationResultOutputSchema,
      ConfigChangeOutputSchema,
      CwdChangedOutputSchema,
      FileChangedOutputSchema,
      InstructionsLoadedOutputSchema,
    ])
    .optional(),
  suppressOutput: z.boolean().optional(),
});

// ============================================================================
// Hook Configuration Schemas
// ============================================================================

const CommandHookSchema = z.object({
  type: z.literal(HookType.Command),
  command: z.string(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
});

const PromptHookSchema = z.object({
  type: z.literal(HookType.Prompt),
  prompt: z.string(),
  timeout: z.number().positive().optional(),
});

const HookSchema = z.discriminatedUnion('type', [CommandHookSchema, PromptHookSchema]);

// 支持字符串或字符串数组
const StringOrArraySchema = z.union([z.string(), z.array(z.string())]);

const MatcherConfigSchema = z.object({
  tools: StringOrArraySchema.optional(),
  paths: StringOrArraySchema.optional(),
  commands: StringOrArraySchema.optional(),
});

const HookMatcherSchema = z.object({
  name: z.string().optional(),
  matcher: MatcherConfigSchema.optional(),
  hooks: z.array(HookSchema),
});

const _HookConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultTimeout: z.number().positive().optional(),
  timeoutBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  failureBehavior: z.enum(['ignore', 'deny', 'ask']).optional(),
  maxConcurrentHooks: z.number().positive().optional(),
  // 工具执行类
  PreToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUse: z.array(HookMatcherSchema).optional(),
  PostToolUseFailure: z.array(HookMatcherSchema).optional(),
  PermissionRequest: z.array(HookMatcherSchema).optional(),
  // 会话生命周期类
  UserPromptSubmit: z.array(HookMatcherSchema).optional(),
  SessionStart: z.array(HookMatcherSchema).optional(),
  SessionEnd: z.array(HookMatcherSchema).optional(),
  // 控制流类
  Stop: z.array(HookMatcherSchema).optional(),
  SubagentStart: z.array(HookMatcherSchema).optional(),
  SubagentStop: z.array(HookMatcherSchema).optional(),
  TaskCompleted: z.array(HookMatcherSchema).optional(),
  // 其他
  Notification: z.array(HookMatcherSchema).optional(),
  Compaction: z.array(HookMatcherSchema).optional(),
  // 控制流扩展
  StopFailure: z.array(HookMatcherSchema).optional(),
  // 压缩生命周期
  PreCompact: z.array(HookMatcherSchema).optional(),
  PostCompact: z.array(HookMatcherSchema).optional(),
  // MCP 交互
  Elicitation: z.array(HookMatcherSchema).optional(),
  ElicitationResult: z.array(HookMatcherSchema).optional(),
  // 配置
  ConfigChange: z.array(HookMatcherSchema).optional(),
  // 环境
  CwdChanged: z.array(HookMatcherSchema).optional(),
  FileChanged: z.array(HookMatcherSchema).optional(),
  // 指令
  InstructionsLoaded: z.array(HookMatcherSchema).optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * 安全解析 Hook 输出 (不抛出异常)
 */
export function safeParseHookOutput(
  data: unknown
):
  | { success: true; data: z.infer<typeof HookOutputSchema> }
  | { success: false; error: z.ZodError } {
  const result = HookOutputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
