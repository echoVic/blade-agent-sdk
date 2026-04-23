/**
 * Hook System Types
 *
 * 定义 Blade Hooks System 的核心类型
 */

import type { ToolResult } from '../../tools/types/ToolResult.js';
import type { SessionId } from '../../types/branded.js';
import type { JsonObject, JsonValue, PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import type { Assert, Extends } from '../../types/typeAssertions.js';

// ============================================================================
// Hook Input
// ============================================================================

/**
 * Hook 输入基础字段
 */
export interface HookInputBase {
  /** Hook 事件名称 */
  hook_event_name: HookEvent;

  /** Hook 执行唯一 ID */
  hook_execution_id: string;

  /** 时间戳 (ISO 8601) */
  timestamp: string;

  /** 项目目录 */
  project_dir: string;

  /** 会话 ID */
  session_id: string;

  /** 当前权限模式 */
  permission_mode: PermissionMode;

  /** 元数据 */
  _metadata?: {
    blade_version: string;
    hook_timeout_ms: number;
  };
}

/**
 * PreToolUse 输入
 */
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PreToolUse;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: JsonObject;
}

/**
 * PostToolUse 输入
 */
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PostToolUse;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: JsonObject;

  /** 工具响应 */
  tool_response: ToolResult;
}

/**
 * Stop 输入
 */
export interface StopInput extends HookInputBase {
  hook_event_name: typeof HookEvent.Stop;

  /** 停止原因 */
  reason?: string;
}

/**
 * PostToolUseFailure 输入
 */
export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PostToolUseFailure;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: JsonObject;

  /** 错误信息 */
  error: string;

  /** 错误类型 */
  error_type?: string;

  /** 是否被中断 */
  is_interrupt: boolean;

  /** 是否超时 */
  is_timeout: boolean;
}

/**
 * PermissionRequest 输入
 */
export interface PermissionRequestInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PermissionRequest;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: JsonObject;
}

/**
 * UserPromptSubmit 输入
 */
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: typeof HookEvent.UserPromptSubmit;

  /** 用户原始提示词 */
  user_prompt: string;

  /** 是否包含图片 */
  has_images: boolean;

  /** 图片数量 */
  image_count: number;
}

/**
 * SessionStart 输入
 */
export interface SessionStartInput extends HookInputBase {
  hook_event_name: typeof HookEvent.SessionStart;

  /** 是否恢复会话 */
  is_resume: boolean;

  /** 恢复的会话 ID */
  resume_session_id?: string;
}

/**
 * SessionEnd 输入
 */
export interface SessionEndInput extends HookInputBase {
  hook_event_name: typeof HookEvent.SessionEnd;

  /** 结束原因 */
  reason:
    | 'user_exit'
    | 'error'
    | 'max_turns'
    | 'idle_timeout'
    | 'ctrl_c'
    | 'esc'
    | 'clear'
    | 'logout'
    | 'other';
}

/**
 * SubagentStart 输入
 */
export interface SubagentStartInput extends HookInputBase {
  hook_event_name: typeof HookEvent.SubagentStart;

  /** 子 Agent 类型 (如 Bash, Explore, Plan 或自定义 agent 名称) */
  agent_type: string;

  /** 任务描述 */
  task_description?: string;

  /** 父 Agent ID */
  parent_agent_id?: string;
}

/**
 * SubagentStop 输入
 */
export interface SubagentStopInput extends HookInputBase {
  hook_event_name: typeof HookEvent.SubagentStop;

  /** 子 Agent 类型 */
  agent_type: string;

  /** 任务描述 */
  task_description?: string;

  /** 是否成功 */
  success: boolean;

  /** 结果摘要 */
  result_summary?: string;

  /** 错误信息 */
  error?: string;
}

/**
 * TaskCompleted 输入
 */
export interface TaskCompletedInput extends HookInputBase {
  hook_event_name: typeof HookEvent.TaskCompleted;

  /** 任务 ID */
  task_id: string;

  /** 任务描述 */
  task_description: string;

  /** 任务结果摘要 */
  result_summary?: string;

  /** 是否成功 */
  success: boolean;
}

/**
 * Notification 输入
 */
export interface NotificationInput extends HookInputBase {
  hook_event_name: typeof HookEvent.Notification;

  /** 通知类型 */
  notification_type:
    | 'permission_prompt'
    | 'idle_prompt'
    | 'auth_success'
    | 'elicitation_dialog'
    | 'info'
    | 'warning'
    | 'error';

  /** 通知标题 */
  title?: string;

  /** 通知内容 */
  message: string;
}

/**
 * Compaction 输入
 */
export interface CompactionInput extends HookInputBase {
  hook_event_name: typeof HookEvent.Compaction;

  /** 触发方式 */
  trigger: 'manual' | 'auto';

  /** 压缩前消息数 */
  messages_before: number;

  /** 压缩前 token 数 */
  tokens_before: number;
}

/**
 * StopFailure 输入
 */
export interface StopFailureInput extends HookInputBase {
  hook_event_name: typeof HookEvent.StopFailure;
  reason: string;
  error?: string;
  tool_name?: string;
}

/**
 * PreCompact 输入
 */
export interface PreCompactInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PreCompact;
  trigger: 'manual' | 'auto';
  messages_before: number;
  tokens_before: number;
}

/**
 * PostCompact 输入
 */
export interface PostCompactInput extends HookInputBase {
  hook_event_name: typeof HookEvent.PostCompact;
  trigger: 'manual' | 'auto';
  messages_before: number;
  messages_after: number;
  tokens_before: number;
  tokens_after: number;
  summary?: string;
}

/**
 * Elicitation 输入
 */
export interface ElicitationInput extends HookInputBase {
  hook_event_name: typeof HookEvent.Elicitation;
  server_name: string;
  resource_uri?: string;
  message?: string;
}

/**
 * ElicitationResult 输入
 */
export interface ElicitationResultInput extends HookInputBase {
  hook_event_name: typeof HookEvent.ElicitationResult;
  server_name: string;
  response?: string;
  was_cancelled: boolean;
}

/**
 * ConfigChange 输入
 */
export interface ConfigChangeInput extends HookInputBase {
  hook_event_name: typeof HookEvent.ConfigChange;
  changed_keys: string[];
  source: 'file' | 'command' | 'environment';
}

/**
 * CwdChanged 输入
 */
export interface CwdChangedInput extends HookInputBase {
  hook_event_name: typeof HookEvent.CwdChanged;
  old_cwd: string;
  new_cwd: string;
}

/**
 * FileChanged 输入
 */
export interface FileChangedInput extends HookInputBase {
  hook_event_name: typeof HookEvent.FileChanged;
  file_path: string;
  change_type: 'created' | 'modified' | 'deleted';
}

/**
 * InstructionsLoaded 输入
 */
export interface InstructionsLoadedInput extends HookInputBase {
  hook_event_name: typeof HookEvent.InstructionsLoaded;
  source: string;
  instructions_length: number;
}

/**
 * Hook 输入联合类型
 */
export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | PermissionRequestInput
  | UserPromptSubmitInput
  | SessionStartInput
  | SessionEndInput
  | StopInput
  | SubagentStartInput
  | SubagentStopInput
  | TaskCompletedInput
  | NotificationInput
  | CompactionInput
  | StopFailureInput
  | PreCompactInput
  | PostCompactInput
  | ElicitationInput
  | ElicitationResultInput
  | ConfigChangeInput
  | CwdChangedInput
  | FileChangedInput
  | InstructionsLoadedInput;

// ============================================================================
// Hook Output
// ============================================================================

/**
 * 决策行为
 */
export enum DecisionBehavior {
  /** 批准,继续执行 */
  Approve = 'approve',

  /** 阻止,停止执行 */
  Block = 'block',

  /** 异步执行,不等待结果 */
  Async = 'async',
}

/**
 * 权限决策 (与 Blade 权限体系对齐)
 */
export enum PermissionDecision {
  Allow = 'allow',
  Deny = 'deny',
  Ask = 'ask',
}

/**
 * PreToolUse 特定输出
 */
interface PreToolUseOutput {
  hookEventName?: 'PreToolUse';

  /** 权限决策 */
  permissionDecision?: PermissionDecision;

  /** 权限决策原因 */
  permissionDecisionReason?: string;

  /** 修改后的工具输入 */
  updatedInput?: JsonObject;
}

/**
 * PostToolUse 特定输出
 */
interface PostToolUseOutput {
  hookEventName?: 'PostToolUse';

  /** 添加给 LLM 的额外上下文 */
  additionalContext?: string;

  /** 修改后的工具输出 */
  updatedOutput?: JsonValue;
}

/**
 * Stop 特定输出
 */
interface StopOutput {
  hookEventName?: 'Stop';

  /** 阻止停止，继续执行 */
  continue?: boolean;

  /** 继续执行的原因 (发送给 LLM) */
  continueReason?: string;
}

/**
 * SubagentStart 特定输出
 */
interface SubagentStartOutput {
  hookEventName?: 'SubagentStart';

  /** 额外上下文注入给子 agent */
  additionalContext?: string;
}

/**
 * SubagentStop 特定输出
 */
interface SubagentStopOutput {
  hookEventName?: 'SubagentStop';

  /** 阻止停止，继续执行 */
  continue?: boolean;

  /** 继续执行的原因 */
  continueReason?: string;

  /** 额外上下文 */
  additionalContext?: string;
}

/**
 * TaskCompleted 特定输出
 */
interface TaskCompletedOutput {
  hookEventName?: 'TaskCompleted';

  /** 阻止任务完成 */
  blockCompletion?: boolean;

  /** 阻止原因 (会反馈给 Claude) */
  blockReason?: string;
}

/**
 * PermissionRequest 特定输出
 */
interface PermissionRequestOutput {
  hookEventName?: 'PermissionRequest';

  /** 权限决策: approve (直接批准), deny (拒绝), ask (显示确认对话框) */
  permissionDecision?: 'approve' | 'deny' | 'ask';

  /** 决策原因 */
  permissionDecisionReason?: string;
}

/**
 * UserPromptSubmit 特定输出
 */
interface UserPromptSubmitOutput {
  hookEventName?: 'UserPromptSubmit';

  /** 修改后的用户提示词 */
  updatedPrompt?: string;

  /** 注入到上下文的内容 (来自 stdout) */
  contextInjection?: string;
}

/**
 * SessionStart 特定输出
 */
interface SessionStartOutput {
  hookEventName?: 'SessionStart';

  /** 环境变量 (持久化到整个会话) */
  env?: Record<string, string>;
}

/**
 * Compaction 特定输出
 */
interface CompactionOutput {
  hookEventName?: 'Compaction';

  /** 阻止压缩 */
  blockCompaction?: boolean;

  /** 阻止原因 */
  blockReason?: string;
}

/**
 * StopFailure 特定输出
 */
interface StopFailureOutput {
  hookEventName?: 'StopFailure';
  shouldRetry?: boolean;
  retryReason?: string;
}

/**
 * PreCompact 特定输出
 */
interface PreCompactOutput {
  hookEventName?: 'PreCompact';
  blockCompaction?: boolean;
  blockReason?: string;
}

/**
 * PostCompact 特定输出
 */
interface PostCompactOutput {
  hookEventName?: 'PostCompact';
  additionalContext?: string;
}

/**
 * Elicitation 特定输出
 */
interface ElicitationOutput {
  hookEventName?: 'Elicitation';
  proceed?: boolean;
  response?: string;
}

/**
 * ElicitationResult 特定输出
 */
interface ElicitationResultOutput {
  hookEventName?: 'ElicitationResult';
  proceed?: boolean;
}

/**
 * ConfigChange 特定输出
 */
interface ConfigChangeOutput {
  hookEventName?: 'ConfigChange';
  proceed?: boolean;
}

/**
 * CwdChanged 特定输出
 */
interface CwdChangedOutput {
  hookEventName?: 'CwdChanged';
  proceed?: boolean;
}

/**
 * FileChanged 特定输出
 */
interface FileChangedOutput {
  hookEventName?: 'FileChanged';
  action?: 'reload' | 'ignore';
}

/**
 * InstructionsLoaded 特定输出
 */
interface InstructionsLoadedOutput {
  hookEventName?: 'InstructionsLoaded';
  proceed?: boolean;
  modified_instructions?: string;
}

/**
 * Hook 特定输出联合类型
 */
export type HookSpecificOutput =
  | PreToolUseOutput
  | PostToolUseOutput
  | StopOutput
  | SubagentStartOutput
  | SubagentStopOutput
  | TaskCompletedOutput
  | PermissionRequestOutput
  | UserPromptSubmitOutput
  | SessionStartOutput
  | CompactionOutput
  | StopFailureOutput
  | PreCompactOutput
  | PostCompactOutput
  | ElicitationOutput
  | ElicitationResultOutput
  | ConfigChangeOutput
  | CwdChangedOutput
  | FileChangedOutput
  | InstructionsLoadedOutput;

/**
 * Hook 输出结构
 */
export interface HookOutput {
  /** 通用决策 */
  decision?: {
    behavior?: DecisionBehavior;
  };

  /** 系统消息 (显示给用户,不发送给 LLM) */
  systemMessage?: string;

  /** 事件特定输出 */
  hookSpecificOutput?: HookSpecificOutput;

  /** 抑制输出 (不显示成功消息) */
  suppressOutput?: boolean;
}

// ============================================================================
// Hook Configuration
// ============================================================================

/**
 * Hook 类型
 */
export enum HookType {
  Command = 'command',
  Prompt = 'prompt',
}

/**
 * 命令 Hook
 */
export interface CommandHook {
  type: HookType.Command;

  /** Shell 命令 */
  command: string;

  /** 超时时间 (秒) */
  timeout?: number;

  /** 状态消息 (显示在 UI) */
  statusMessage?: string;
}

/**
 * 提示词 Hook (未来实现)
 */
interface PromptHook {
  type: HookType.Prompt;

  /** 提示词内容 */
  prompt: string;

  /** 超时时间 (秒) */
  timeout?: number;
}

/**
 * Hook 联合类型
 */
export type Hook = CommandHook | PromptHook;

/**
 * Matcher 配置
 */
export interface MatcherConfig {
  /** 工具名匹配 (支持精确、管道分隔、正则、或数组) */
  tools?: string | string[];

  /** 文件路径匹配 (glob 模式) */
  paths?: string | string[];

  /** 命令匹配 (正则) */
  commands?: string | string[];
}

/**
 * Hook Matcher
 */
export interface HookMatcher {
  /** 可选的名称 (用于日志和 UI) */
  name?: string;

  /** 匹配器配置 */
  matcher?: MatcherConfig;

  /** Hook 列表 */
  hooks: Hook[];
}

/**
 * Hook 配置
 * 与 Claude Code 对齐的完整配置
 */
export interface HookConfig {
  /** 是否启用 hooks */
  enabled?: boolean;

  /** 默认超时 (秒) */
  defaultTimeout?: number;

  /** 超时行为 */
  timeoutBehavior?: 'ignore' | 'deny' | 'ask';

  /** 失败行为 */
  failureBehavior?: 'ignore' | 'deny' | 'ask';

  /** 最大并发 Hook 数 */
  maxConcurrentHooks?: number;

  // ========== 工具执行类 ==========
  /** PreToolUse Hooks */
  PreToolUse?: HookMatcher[];

  /** PostToolUse Hooks */
  PostToolUse?: HookMatcher[];

  /** PostToolUseFailure Hooks */
  PostToolUseFailure?: HookMatcher[];

  /** PermissionRequest Hooks */
  PermissionRequest?: HookMatcher[];

  // ========== 会话生命周期类 ==========
  /** UserPromptSubmit Hooks */
  UserPromptSubmit?: HookMatcher[];

  /** SessionStart Hooks */
  SessionStart?: HookMatcher[];

  /** SessionEnd Hooks */
  SessionEnd?: HookMatcher[];

  // ========== 控制流类 ==========
  /** Stop Hooks */
  Stop?: HookMatcher[];

  /** SubagentStart Hooks */
  SubagentStart?: HookMatcher[];

  /** SubagentStop Hooks */
  SubagentStop?: HookMatcher[];

  /** TaskCompleted Hooks */
  TaskCompleted?: HookMatcher[];

  // ========== 其他 ==========
  /** Notification Hooks */
  Notification?: HookMatcher[];

  /** Compaction Hooks */
  Compaction?: HookMatcher[];

  // ========== 控制流扩展 ==========
  /** StopFailure Hooks */
  StopFailure?: HookMatcher[];

  // ========== 压缩生命周期 ==========
  /** PreCompact Hooks */
  PreCompact?: HookMatcher[];

  /** PostCompact Hooks */
  PostCompact?: HookMatcher[];

  // ========== MCP 交互 ==========
  /** Elicitation Hooks */
  Elicitation?: HookMatcher[];

  /** ElicitationResult Hooks */
  ElicitationResult?: HookMatcher[];

  // ========== 配置 ==========
  /** ConfigChange Hooks */
  ConfigChange?: HookMatcher[];

  // ========== 环境 ==========
  /** CwdChanged Hooks */
  CwdChanged?: HookMatcher[];

  /** FileChanged Hooks */
  FileChanged?: HookMatcher[];

  // ========== 指令 ==========
  /** InstructionsLoaded Hooks */
  InstructionsLoaded?: HookMatcher[];
}

type HookConfigEventKeys = Exclude<keyof HookConfig, 'enabled' | 'defaultTimeout' | 'timeoutBehavior' | 'failureBehavior' | 'maxConcurrentHooks'>;
type _AssertHookConfigComplete = Assert<Extends<HookEvent, HookConfigEventKeys>>;
type _AssertNoExtraKeys = Assert<Extends<HookConfigEventKeys, HookEvent>>;

// ============================================================================
// Hook Execution Results
// ============================================================================

/**
 * Hook 退出码
 */
export enum HookExitCode {
  /** 成功,继续 */
  SUCCESS = 0,

  /** 非阻塞错误,记录但继续 */
  NON_BLOCKING_ERROR = 1,

  /** 阻塞错误,停止执行 */
  BLOCKING_ERROR = 2,

  /** 超时 */
  TIMEOUT = 124,
}

/**
 * 进程执行结果
 */
export interface ProcessResult {
  /** 标准输出 */
  stdout: string;

  /** 标准错误 */
  stderr: string;

  /** 退出码 */
  exitCode: number;

  /** 是否超时 */
  timedOut: boolean;
}

/**
 * Hook 执行结果
 */
export interface HookExecutionResult {
  /** 是否成功 */
  success: boolean;

  /** 是否阻塞 */
  blocking?: boolean;

  /** 是否需要用户确认 (ask 行为) */
  needsConfirmation?: boolean;

  /** 错误信息 */
  error?: string;

  /** 警告信息 */
  warning?: string;

  /** 解析后的输出 */
  output?: HookOutput;

  /** 原始标准输出 */
  stdout?: string;

  /** 原始标准错误 */
  stderr?: string;

  /** 退出码 */
  exitCode?: number;

  /** Hook 配置 */
  hook?: Hook;
}

/**
 * PreToolUse Hook 执行结果
 */
export interface PreToolHookResult {
  /** 决策 */
  decision: 'allow' | 'deny' | 'ask';

  /** 原因 */
  reason?: string;

  /** 修改后的输入 */
  modifiedInput?: JsonObject;

  /** 警告信息 */
  warning?: string;
}

/**
 * PostToolUse Hook 执行结果
 */
export interface PostToolHookResult {
  /** 额外上下文 */
  additionalContext?: string;

  /** 修改后的输出 */
  modifiedOutput?: JsonValue;

  /** 警告信息 */
  warning?: string;
}

/**
 * Stop Hook 执行结果
 */
export interface StopHookResult {
  /** 是否应该停止 (false 表示继续执行) */
  shouldStop: boolean;

  /** 继续执行的原因 */
  continueReason?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * SubagentStart Hook 执行结果
 */
export interface SubagentStartHookResult {
  /** 是否继续启动 */
  proceed: boolean;

  /** 额外上下文注入给子 agent */
  additionalContext?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * SubagentStop Hook 执行结果
 */
export interface SubagentStopHookResult {
  /** 是否应该停止 */
  shouldStop: boolean;

  /** 继续执行的原因 */
  continueReason?: string;

  /** 额外上下文 */
  additionalContext?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * TaskCompleted Hook 执行结果
 */
export interface TaskCompletedHookResult {
  /** 是否允许完成 */
  allowCompletion: boolean;

  /** 阻止原因 (会反馈给 Claude) */
  blockReason?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * PermissionRequest Hook 执行结果
 */
export interface PermissionRequestHookResult {
  /** 权限决策 */
  decision: 'approve' | 'deny' | 'ask';

  /** 决策原因 */
  reason?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * UserPromptSubmit Hook 执行结果
 */
export interface UserPromptSubmitHookResult {
  /** 是否继续处理 */
  proceed: boolean;

  /** 修改后的提示词 */
  updatedPrompt?: string;

  /** 注入到上下文的内容 */
  contextInjection?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * SessionStart Hook 执行结果
 */
export interface SessionStartHookResult {
  /** 是否继续启动 */
  proceed: boolean;

  /** 环境变量 */
  env?: Record<string, string>;

  /** 警告信息 */
  warning?: string;
}

/**
 * SessionEnd Hook 执行结果
 * (通常不需要特殊处理)
 */
export interface SessionEndHookResult {
  /** 警告信息 */
  warning?: string;
}

/**
 * PostToolUseFailure Hook 执行结果
 */
export interface PostToolUseFailureHookResult {
  /** 额外上下文 */
  additionalContext?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * Notification Hook 执行结果
 */
export interface NotificationHookResult {
  /** 是否抑制通知 */
  suppress: boolean;

  /** 修改后的消息 */
  message: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * Compaction Hook 执行结果
 */
export interface CompactionHookResult {
  /** 是否阻止压缩 */
  blockCompaction: boolean;

  /** 阻止原因 */
  blockReason?: string;

  /** 警告信息 */
  warning?: string;
}

/**
 * StopFailure Hook 执行结果
 */
export interface StopFailureHookResult {
  shouldRetry: boolean;
  retryReason?: string;
  warning?: string;
}

/**
 * PreCompact Hook 执行结果
 */
export interface PreCompactHookResult {
  blockCompaction: boolean;
  blockReason?: string;
  warning?: string;
}

/**
 * PostCompact Hook 执行结果
 */
export interface PostCompactHookResult {
  additionalContext?: string;
  warning?: string;
}

/**
 * Elicitation Hook 执行结果
 */
export interface ElicitationHookResult {
  proceed: boolean;
  response?: string;
  warning?: string;
}

/**
 * ElicitationResult Hook 执行结果
 */
export interface ElicitationResultHookResult {
  proceed: boolean;
  warning?: string;
}

/**
 * ConfigChange Hook 执行结果
 */
export interface ConfigChangeHookResult {
  proceed: boolean;
  warning?: string;
}

/**
 * CwdChanged Hook 执行结果
 */
export interface CwdChangedHookResult {
  proceed: boolean;
  warning?: string;
}

/**
 * FileChanged Hook 执行结果
 */
export interface FileChangedHookResult {
  action: 'reload' | 'ignore';
  warning?: string;
}

/**
 * InstructionsLoaded Hook 执行结果
 */
export interface InstructionsLoadedHookResult {
  proceed: boolean;
  modified_instructions?: string;
  warning?: string;
}

// ============================================================================
// Hook Execution Context
// ============================================================================

/**
 * Hook 执行上下文
 */
export interface HookExecutionContext {
  /** 项目目录 */
  projectDir: string;

  /** 会话 ID */
  sessionId: SessionId;

  /** 权限模式 */
  permissionMode: PermissionMode;

  /** Hook 配置 */
  config: HookConfig;

  /** 中止信号 */
  abortSignal?: AbortSignal;
}

/**
 * Matcher 匹配上下文
 */
export interface MatchContext {
  /** 工具名称 */
  toolName?: string;

  /** 文件路径 */
  filePath?: string;

  /** 命令 */
  command?: string;
}
