/**
 * Hook Manager
 *
 * 管理 Hook 配置和执行
 */

import { nanoid } from 'nanoid';
import type { ToolResult } from '../tools/types/index.js';
import { SessionId, type ToolUseId } from './branded.js';
import type { JsonObject } from '../types/common.js';
import { HookEvent, PermissionMode } from '../types/constants.js';
import { DEFAULT_HOOK_CONFIG, mergeHookConfig, parseEnvConfig } from './HookConfig.js';
import { HookExecutionGuard } from './HookExecutionGuard.js';
import { HookExecutor } from './HookExecutor.js';
import { Matcher } from './Matcher.js';
import type {
  CompactionHookResult,
  CompactionInput,
  ConfigChangeHookResult,
  ConfigChangeInput,
  CwdChangedHookResult,
  CwdChangedInput,
  ElicitationHookResult,
  ElicitationInput,
  ElicitationResultHookResult,
  ElicitationResultInput,
  FileChangedHookResult,
  FileChangedInput,
  Hook,
  HookConfig,
  HookExecutionContext,
  InstructionsLoadedHookResult,
  InstructionsLoadedInput,
  MatchContext,
  NotificationHookResult,
  NotificationInput,
  PermissionRequestHookResult,
  PermissionRequestInput,
  PostCompactHookResult,
  PostCompactInput,
  PostToolHookResult,
  PostToolUseFailureHookResult,
  PostToolUseFailureInput,
  PostToolUseInput,
  PreCompactHookResult,
  PreCompactInput,
  PreToolHookResult,
  PreToolUseInput,
  SessionEndHookResult,
  SessionEndInput,
  SessionStartHookResult,
  SessionStartInput,
  StopFailureHookResult,
  StopFailureInput,
  StopHookResult,
  StopInput,
  SubagentStartHookResult,
  SubagentStartInput,
  SubagentStopHookResult,
  SubagentStopInput,
  TaskCompletedHookResult,
  TaskCompletedInput,
  UserPromptSubmitHookResult,
  UserPromptSubmitInput
} from './hookTypes.js';

/**
 * Hook Manager
 *
 * 单例模式,管理整个应用的 Hook 系统
 */
export class HookManager {
  private static instance: HookManager | null = null;

  private config: HookConfig = DEFAULT_HOOK_CONFIG;
  private executor = new HookExecutor();
  private guard = new HookExecutionGuard();
  private matcher = new Matcher();
  private sessionDisabled = false;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): HookManager {
    if (!HookManager.instance) {
      HookManager.instance = new HookManager();
    }
    return HookManager.instance;
  }

  /**
   * 加载配置
   */
  loadConfig(config: Partial<HookConfig>): void {
    // 合并配置: 默认 -> 用户配置 -> 环境变量
    let merged = mergeHookConfig(DEFAULT_HOOK_CONFIG, config);
    const envConfig = parseEnvConfig();
    merged = mergeHookConfig(merged, envConfig);

    this.config = merged;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    // 1. 全局配置开关
    if (!this.config.enabled) {
      return false;
    }

    // 2. 会话级禁用
    if (this.sessionDisabled) {
      return false;
    }

    return true;
  }

  /**
   * 运行时禁用 (当前会话)
   */
  disable(): void {
    this.sessionDisabled = true;
    console.log('[HookManager] Hooks disabled for this session');
  }

  /**
   * 运行时启用 (当前会话)
   */
  enable(): void {
    this.sessionDisabled = false;
    console.log('[HookManager] Hooks enabled for this session');
  }

  /**
   * 获取当前配置（只读）
   */
  getConfig(): Readonly<HookConfig> {
    return this.config;
  }

  /**
   * 重新加载配置（直接从配置文件读取）
   * @param settingsFilePath 配置文件路径（如 path.join(projectDir, '.myapp', 'settings.local.json')）
   */
  async reloadConfig(settingsFilePath?: string): Promise<void> {
    const fs = await import('node:fs/promises');

    if (!settingsFilePath) {
      return;
    }

    try {
      const content = await fs.readFile(settingsFilePath, 'utf-8');
      const settings = JSON.parse(content);

      if (settings.hooks) {
        const _oldConfig = { ...this.config };
        this.loadConfig(settings.hooks);

        // 触发 ConfigChange hook
        const changedKeys = Object.keys(settings.hooks);
        if (changedKeys.length > 0) {
          const configChangeInput: ConfigChangeInput = {
            hook_event_name: HookEvent.ConfigChange,
            hook_execution_id: nanoid(),
            timestamp: new Date().toISOString(),
            project_dir: '',
            session_id: SessionId('system'),
            permission_mode: PermissionMode.DEFAULT,
            changed_keys: changedKeys,
            source: 'file',
          };

          const configChangeHooks = this.getMatchingHooks(HookEvent.ConfigChange, {});
          if (configChangeHooks.length > 0) {
            const execContext: HookExecutionContext = {
              projectDir: '',
              sessionId: 'system' as SessionId,
              permissionMode: PermissionMode.DEFAULT,
              config: this.config,
            };

            await this.executor.executeConfigChangeHooks(
              configChangeHooks,
              configChangeInput,
              execContext
            ).catch((err) => {
              console.error('[HookManager] ConfigChange hook failed:', err);
            });
          }
        }
      }
    } catch (err) {
      console.error('[HookManager] Failed to reload config:', err);
    }
  }

  /**
   * 执行 PreToolUse Hooks
   */
  async executePreToolUseHooks(
    params: {
      toolName: string;
      toolInput: JsonObject;
      toolUseId: ToolUseId;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PreToolHookResult> {
    if (!this.isEnabled()) {
      return { decision: 'allow' };
    }

    const hookInput: PreToolUseInput = {
      hook_event_name: HookEvent.PreToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      tool_name: params.toolName,
      tool_use_id: params.toolUseId,
      tool_input: params.toolInput,
    };

    const context: MatchContext = {
      toolName: params.toolName,
      filePath: this.extractFilePath(params.toolInput),
      command: this.extractCommand(params.toolName, params.toolInput),
    };

    const hooks = this.getMatchingHooks(HookEvent.PreToolUse, context);

    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePreToolHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PreToolUse hooks:', err);
      return {
        decision: 'allow',
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostToolUse Hooks
   */
  async executePostToolUseHooks(
    params: {
      toolName: string;
      toolInput: JsonObject;
      toolResponse: ToolResult;
      toolUseId: ToolUseId;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PostToolHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    const hookInput: PostToolUseInput = {
      hook_event_name: HookEvent.PostToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      tool_name: params.toolName,
      tool_use_id: params.toolUseId,
      tool_input: params.toolInput,
      tool_response: params.toolResponse,
    };

    const context: MatchContext = {
      toolName: params.toolName,
      filePath: this.extractFilePath(params.toolInput),
      command: this.extractCommand(params.toolName, params.toolInput),
    };

    const hooks = this.getMatchingHooks(HookEvent.PostToolUse, context);

    if (hooks.length === 0) {
      return {};
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePostToolHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUse hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostToolUseFailure Hooks
   */
  async executePostToolUseFailureHooks(
    params: {
      toolName: string;
      toolInput: JsonObject;
      error: string;
      errorType?: string;
      isInterrupt: boolean;
      isTimeout: boolean;
      toolUseId: ToolUseId;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PostToolUseFailureHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    const hookInput: PostToolUseFailureInput = {
      hook_event_name: HookEvent.PostToolUseFailure,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      tool_name: params.toolName,
      tool_use_id: params.toolUseId,
      tool_input: params.toolInput,
      error: params.error,
      error_type: params.errorType,
      is_interrupt: params.isInterrupt,
      is_timeout: params.isTimeout,
    };

    const context: MatchContext = {
      toolName: params.toolName,
      filePath: this.extractFilePath(params.toolInput),
      command: this.extractCommand(params.toolName, params.toolInput),
    };

    const hooks = this.getMatchingHooks(HookEvent.PostToolUseFailure, context);

    if (hooks.length === 0) {
      return {};
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePostToolUseFailureHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUseFailure hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Stop Hooks
   */
  async executeStopHooks(
    params: {
      reason?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<StopHookResult> {
    if (!this.isEnabled()) {
      return { shouldStop: true };
    }

    const hookInput: StopInput = {
      hook_event_name: HookEvent.Stop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      reason: params.reason,
    };

    const hooks = this.getMatchingHooks(HookEvent.Stop, {});

    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing Stop hooks:', err);
      return {
        shouldStop: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SubagentStart Hooks
   */
  async executeSubagentStartHooks(
    params: {
      agentType: string;
      taskDescription?: string;
      parentAgentId?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<SubagentStartHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: SubagentStartInput = {
      hook_event_name: HookEvent.SubagentStart,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      agent_type: params.agentType,
      task_description: params.taskDescription,
      parent_agent_id: params.parentAgentId,
    };

    const hooks = this.getMatchingHooks(HookEvent.SubagentStart, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeSubagentStartHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing SubagentStart hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SubagentStop Hooks
   */
  async executeSubagentStopHooks(
    params: {
      agentType: string;
      taskDescription?: string;
      wasSuccessful?: boolean;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<SubagentStopHookResult> {
    if (!this.isEnabled()) {
      return { shouldStop: false };
    }

    const hookInput: SubagentStopInput = {
      hook_event_name: HookEvent.SubagentStop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      agent_type: params.agentType,
      task_description: params.taskDescription,
      success: params.wasSuccessful ?? false,
    };

    const hooks = this.getMatchingHooks(HookEvent.SubagentStop, {});

    if (hooks.length === 0) {
      return { shouldStop: false };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeSubagentStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing SubagentStop hooks:', err);
      return {
        shouldStop: false,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 TaskCompleted Hooks
   */
  async executeTaskCompletedHooks(
    params: {
      taskSummary?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<TaskCompletedHookResult> {
    if (!this.isEnabled()) {
      return { allowCompletion: true };
    }

    const hookInput: TaskCompletedInput = {
      hook_event_name: HookEvent.TaskCompleted,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      task_id: 'task-completed',
      task_description: params.taskSummary || 'Task completed',
      success: true,
      result_summary: params.taskSummary,
    };

    const hooks = this.getMatchingHooks(HookEvent.TaskCompleted, {});

    if (hooks.length === 0) {
      return { allowCompletion: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeTaskCompletedHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing TaskCompleted hooks:', err);
      return {
        allowCompletion: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PermissionRequest Hooks
   */
  async executePermissionRequestHooks(
    params: {
      toolName: string;
      toolInput: JsonObject;
      toolUseId: ToolUseId;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PermissionRequestHookResult> {
    if (!this.isEnabled()) {
      return { decision: 'ask' };
    }

    const hookInput: PermissionRequestInput = {
      hook_event_name: HookEvent.PermissionRequest,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      tool_name: params.toolName,
      tool_use_id: params.toolUseId,
      tool_input: params.toolInput,
    };

    const context: MatchContext = {
      toolName: params.toolName,
      filePath: this.extractFilePath(params.toolInput),
      command: this.extractCommand(params.toolName, params.toolInput),
    };

    const hooks = this.getMatchingHooks(HookEvent.PermissionRequest, context);

    if (hooks.length === 0) {
      return { decision: 'ask' };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePermissionRequestHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PermissionRequest hooks:', err);
      return {
        decision: 'ask',
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 UserPromptSubmit Hooks
   */
  async executeUserPromptSubmitHooks(
    params: {
      userPrompt: string;
      hasImages: boolean;
      imageCount: number;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<UserPromptSubmitHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: UserPromptSubmitInput = {
      hook_event_name: HookEvent.UserPromptSubmit,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      user_prompt: params.userPrompt,
      has_images: params.hasImages,
      image_count: params.imageCount,
    };

    const hooks = this.getMatchingHooks(HookEvent.UserPromptSubmit, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeUserPromptSubmitHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing UserPromptSubmit hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SessionStart Hooks
   */
  async executeSessionStartHooks(
    params: {
      isResume: boolean;
      resumeSessionId?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<SessionStartHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: SessionStartInput = {
      hook_event_name: HookEvent.SessionStart,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      is_resume: params.isResume,
      resume_session_id: params.resumeSessionId,
    };

    const hooks = this.getMatchingHooks(HookEvent.SessionStart, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeSessionStartHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing SessionStart hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SessionEnd Hooks
   */
  async executeSessionEndHooks(
    params: {
      reason: 'user_exit' | 'error' | 'max_turns' | 'idle_timeout' | 'ctrl_c' | 'esc' | 'clear' | 'logout' | 'other';
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<SessionEndHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    const hookInput: SessionEndInput = {
      hook_event_name: HookEvent.SessionEnd,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      reason: params.reason,
    };

    const hooks = this.getMatchingHooks(HookEvent.SessionEnd, {});

    if (hooks.length === 0) {
      return {};
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeSessionEndHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing SessionEnd hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Notification Hooks
   */
  async executeNotificationHooks(
    params: {
      message: string;
      notificationType?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<NotificationHookResult> {
    if (!this.isEnabled()) {
      return { suppress: false, message: '' };
    }

    const hookInput: NotificationInput = {
      hook_event_name: HookEvent.Notification,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      message: params.message,
      notification_type: (params.notificationType as NotificationInput['notification_type']) || 'info',
    };

    const hooks = this.getMatchingHooks(HookEvent.Notification, {});

    if (hooks.length === 0) {
      return { suppress: false, message: params.message };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeNotificationHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing Notification hooks:', err);
      return {
        suppress: false,
        message: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Compaction Hooks
   */
  async executeCompactionHooks(
    params: {
      strategy: string;
      reason?: string;
      messageCount?: number;
      /** Rich fields from CompactionService (ported from root) */
      trigger?: 'manual' | 'auto';
      messagesBefore?: number;
      tokensBefore?: number;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<CompactionHookResult> {
    if (!this.isEnabled()) {
      return { blockCompaction: false };
    }

    const hookInput: CompactionInput = {
      hook_event_name: HookEvent.Compaction,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      trigger: params.trigger ?? 'auto',
      messages_before: params.messagesBefore ?? params.messageCount ?? 0,
      tokens_before: params.tokensBefore ?? 0,
    };

    const hooks = this.getMatchingHooks(HookEvent.Compaction, {});

    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeCompactionHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing Compaction hooks:', err);
      return {
        blockCompaction: false,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 StopFailure Hooks
   */
  async executeStopFailureHooks(
    params: {
      error: string;
      errorType?: string;
      consecutiveFailures: number;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<StopFailureHookResult> {
    if (!this.isEnabled()) {
      return { shouldRetry: false };
    }

    const hookInput: StopFailureInput = {
      hook_event_name: HookEvent.StopFailure,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      reason: params.error,
      error: params.error,
    };

    const hooks = this.getMatchingHooks(HookEvent.StopFailure, {});

    if (hooks.length === 0) {
      return { shouldRetry: false };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeStopFailureHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing StopFailure hooks:', err);
      return {
        shouldRetry: false,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PreCompact Hooks
   */
  async executePreCompactHooks(
    params: {
      strategy: string;
      reason?: string;
      messageCount?: number;
      /** Rich fields from CompactionService (ported from root) */
      trigger?: 'manual' | 'auto';
      messagesBefore?: number;
      tokensBefore?: number;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PreCompactHookResult> {
    if (!this.isEnabled()) {
      return { blockCompaction: false };
    }

    const hookInput: PreCompactInput = {
      hook_event_name: HookEvent.PreCompact,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      trigger: params.trigger ?? 'auto',
      messages_before: params.messagesBefore ?? params.messageCount ?? 0,
      tokens_before: params.tokensBefore ?? 0,
    };

    const hooks = this.getMatchingHooks(HookEvent.PreCompact, {});

    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePreCompactHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PreCompact hooks:', err);
      return {
        blockCompaction: false,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostCompact Hooks
   */
  async executePostCompactHooks(
    params: {
      strategy: string;
      originalCount?: number;
      compactedCount?: number;
      /** Rich fields from CompactionService (ported from root) */
      trigger?: 'manual' | 'auto';
      messagesBefore?: number;
      messagesAfter?: number;
      tokensBefore?: number;
      tokensAfter?: number;
      summary?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<PostCompactHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    const hookInput: PostCompactInput = {
      hook_event_name: HookEvent.PostCompact,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      trigger: params.trigger ?? 'auto',
      messages_before: params.messagesBefore ?? params.originalCount ?? 0,
      messages_after: params.messagesAfter ?? params.compactedCount ?? 0,
      tokens_before: params.tokensBefore ?? 0,
      tokens_after: params.tokensAfter ?? 0,
    };

    const hooks = this.getMatchingHooks(HookEvent.PostCompact, {});

    if (hooks.length === 0) {
      return {};
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executePostCompactHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PostCompact hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Elicitation Hooks
   */
  async executeElicitationHooks(
    params: {
      elicitationId: string;
      message?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<ElicitationHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: ElicitationInput = {
      hook_event_name: HookEvent.Elicitation,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      server_name: params.elicitationId,
      message: params.message,
    };

    const hooks = this.getMatchingHooks(HookEvent.Elicitation, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeElicitationHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing Elicitation hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 ElicitationResult Hooks
   */
  async executeElicitationResultHooks(
    params: {
      elicitationId: string;
      response?: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<ElicitationResultHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: ElicitationResultInput = {
      hook_event_name: HookEvent.ElicitationResult,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      server_name: params.elicitationId,
      response: params.response,
      was_cancelled: false,
    };

    const hooks = this.getMatchingHooks(HookEvent.ElicitationResult, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeElicitationResultHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing ElicitationResult hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 ConfigChange Hooks
   */
  async executeConfigChangeHooks(
    params: {
      changed_keys: string[];
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<ConfigChangeHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: ConfigChangeInput = {
      hook_event_name: HookEvent.ConfigChange,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      changed_keys: params.changed_keys,
      source: 'command',
    };

    const hooks = this.getMatchingHooks(HookEvent.ConfigChange, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const result = await this.executor.executeConfigChangeHooks(
        hooks,
        hookInput,
        execContext
      );
      return result;
    } catch (err) {
      console.error('[HookManager] Error executing ConfigChange hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 CwdChanged Hooks
   */
  async executeCwdChangedHooks(
    params: {
      old_cwd: string;
      new_cwd: string;
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<CwdChangedHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: CwdChangedInput = {
      hook_event_name: HookEvent.CwdChanged,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      old_cwd: params.old_cwd,
      new_cwd: params.new_cwd,
    };

    const hooks = this.getMatchingHooks(HookEvent.CwdChanged, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const results = await this.executor.executeCwdChangedHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing CwdChanged hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 FileChanged Hooks
   */
  async executeFileChangedHooks(
    params: {
      file_path: string;
      change_type: 'created' | 'modified' | 'deleted';
    },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<FileChangedHookResult> {
    if (!this.isEnabled()) {
      return { action: 'reload' };
    }

    const hookInput: FileChangedInput = {
      hook_event_name: HookEvent.FileChanged,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      file_path: params.file_path,
      change_type: params.change_type,
    };

    const hooks = this.getMatchingHooks(HookEvent.FileChanged, {
      filePath: params.file_path,
    });

    if (hooks.length === 0) {
      return { action: 'reload' };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const results = await this.executor.executeFileChangedHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing FileChanged hooks:', err);
      return {
        action: 'reload',
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 InstructionsLoaded Hooks
   */
  async executeInstructionsLoadedHooks(
    params: { source: string; instructions_length: number },
    projectDir: string,
    sessionId: SessionId,
    permissionMode: PermissionMode,
    signal?: AbortSignal
  ): Promise<InstructionsLoadedHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: InstructionsLoadedInput = {
      hook_event_name: HookEvent.InstructionsLoaded,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: projectDir,
      session_id: sessionId,
      permission_mode: permissionMode,
      source: params.source,
      instructions_length: params.instructions_length,
    };

    const hooks = this.getMatchingHooks(HookEvent.InstructionsLoaded, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir,
      sessionId,
      permissionMode,
      config: this.config,
      abortSignal: signal,
    };

    try {
      const results = await this.executor.executeInstructionsLoadedHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing InstructionsLoaded hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 获取匹配的 Hooks
   */
  private getMatchingHooks(event: HookEvent, context: MatchContext): Hook[] {
    const matchers = this.config[event] || [];

    const matchedHooks: Hook[] = [];

    for (const matcher of matchers) {
      if (this.matcher.matches(matcher.matcher, context)) {
        matchedHooks.push(...matcher.hooks);
      }
    }

    return matchedHooks;
  }

  /**
   * 从工具输入提取文件路径
   */
  private extractFilePath(toolInput: JsonObject): string | undefined {
    // 常见的文件路径字段
    const pathFields = ['file_path', 'path', 'filePath', 'source', 'target'];

    for (const field of pathFields) {
      const value = toolInput[field];
      if (typeof value === 'string') {
        return value;
      }
    }

    return undefined;
  }

  /**
   * 从工具输入提取命令
   */
  private extractCommand(
    toolName: string,
    toolInput: JsonObject
  ): string | undefined {
    // Bash 工具的命令
    if (toolName === 'Bash' || toolName === 'BashTool') {
      const cmd = toolInput.command;
      if (typeof cmd === 'string') {
        return cmd;
      }
    }

    return undefined;
  }

  /**
   * 清理所有状态
   */
  cleanup(): void {
    this.guard.cleanupAll();
  }
}
