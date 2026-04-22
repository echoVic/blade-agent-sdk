/**
 * Hook Manager
 *
 * 管理 Hook 配置和执行
 */

import { nanoid } from 'nanoid';
import type { ToolResult } from '../tools/types/ToolResult.js';
import type { JsonObject } from '../types/common.js';
import { HookEvent, PermissionMode } from '../types/constants.js';
import { DEFAULT_HOOK_CONFIG, mergeHookConfig, parseEnvConfig } from './HookConfig.js';
import { HookExecutionGuard } from './HookExecutionGuard.js';
import { HookExecutor } from './HookExecutor.js';
import { Matcher } from './Matcher.js';
import {
  type CompactionHookResult,
  type CompactionInput,
  type ConfigChangeHookResult,
  type ConfigChangeInput,
  type CwdChangedHookResult,
  type CwdChangedInput,
  type ElicitationHookResult,
  type ElicitationInput,
  type ElicitationResultHookResult,
  type ElicitationResultInput,
  type FileChangedHookResult,
  type FileChangedInput,
  type Hook,
  type HookConfig,
  type HookExecutionContext,
  type InstructionsLoadedHookResult,
  type InstructionsLoadedInput,
  type MatchContext,
  type NotificationHookResult,
  type NotificationInput,
  type PermissionRequestHookResult,
  type PermissionRequestInput,
  type PostCompactHookResult,
  type PostCompactInput,
  type PostToolHookResult,
  type PostToolUseFailureHookResult,
  type PostToolUseFailureInput,
  type PostToolUseInput,
  type PreCompactHookResult,
  type PreCompactInput,
  type PreToolHookResult,
  type PreToolUseInput,
  type SessionEndHookResult,
  type SessionEndInput,
  type SessionStartHookResult,
  type SessionStartInput,
  type StopFailureHookResult,
  type StopFailureInput,
  type StopHookResult,
  type StopInput,
  type SubagentStartHookResult,
  type SubagentStartInput,
  type SubagentStopHookResult,
  type SubagentStopInput,
  type TaskCompletedHookResult,
  type TaskCompletedInput,
  type UserPromptSubmitHookResult,
  type UserPromptSubmitInput
} from './types/HookTypes.js';

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
        const oldConfig = { ...this.config };
        this.loadConfig(settings.hooks);

        // 触发 ConfigChange hook
        const changedKeys = Object.keys(settings.hooks);
        if (changedKeys.length > 0) {
          // 异步触发，不阻塞 reloadConfig
          void this.executeConfigChangeHooks(
            { changed_keys: changedKeys, source: 'file' },
            '',
            '',
            PermissionMode.DEFAULT,
          ).catch(() => {});
        }
      }
    } catch {
      // 文件不存在或读取失败，保持当前配置
    }
  }

  /**
   * 执行 PreToolUse Hooks
   */
  async executePreToolHooks(
    toolName: string,
    toolUseId: string,
    toolInput: JsonObject,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PreToolHookResult> {
    if (!this.isEnabled()) {
      return { decision: 'allow' };
    }

    // Plan 模式跳过 hooks
    if (context.permissionMode === 'plan') {
      return { decision: 'allow' };
    }

    // 检查是否已执行
    if (!this.guard.canExecute(toolUseId, HookEvent.PreToolUse)) {
      return { decision: 'allow' };
    }

    // 构建 Hook 输入
    const hookInput: PreToolUseInput = {
      hook_event_name: HookEvent.PreToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(HookEvent.PreToolUse, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    // 执行 hooks
    try {
      const result = await this.executor.executePreToolHooks(
        hooks,
        hookInput,
        execContext
      );

      // 标记已执行
      this.guard.markExecuted(toolUseId, HookEvent.PreToolUse);

      // YOLO 模式：保留 deny 和所有修改，但将 ask 转为 allow
      if (context.permissionMode === 'yolo') {
        if (result.decision === 'deny') {
          // 保留 deny 决策和所有其他字段
          return result;
        }
        // 将 ask 转为 allow，但保留 modifiedInput 和 warning
        return {
          decision: 'allow',
          modifiedInput: result.modifiedInput,
          warning: result.warning,
          reason: result.reason,
        };
      }

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
  async executePostToolHooks(
    toolName: string,
    toolUseId: string,
    toolInput: JsonObject,
    toolResponse: ToolResult,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PostToolHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    // Plan 模式跳过 hooks
    if (context.permissionMode === 'plan') {
      return {};
    }

    // 检查是否已执行
    if (!this.guard.canExecute(toolUseId, HookEvent.PostToolUse)) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: PostToolUseInput = {
      hook_event_name: HookEvent.PostToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      tool_response: toolResponse,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(HookEvent.PostToolUse, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    // 执行 hooks
    try {
      const result = await this.executor.executePostToolHooks(
        hooks,
        hookInput,
        execContext
      );

      // 标记已执行
      this.guard.markExecuted(toolUseId, HookEvent.PostToolUse);

      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUse hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // 清理完成的工具
      this.guard.cleanup(toolUseId);
    }
  }

  /**
   * 执行 Stop Hooks
   */
  async executeStopHooks(context: {
    projectDir: string;
    sessionId: string;
    permissionMode: PermissionMode;
    reason?: string;
    abortSignal?: AbortSignal;
  }): Promise<StopHookResult> {
    if (!this.isEnabled()) {
      return { shouldStop: true };
    }

    // 构建 Hook 输入
    const hookInput: StopInput = {
      hook_event_name: HookEvent.Stop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      reason: context.reason,
    };

    // 获取 hooks (Stop hooks 通常没有匹配器)
    const hooks = this.getMatchingHooks(HookEvent.Stop, {});

    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    agentType: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      taskDescription?: string;
      parentAgentId?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<SubagentStartHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    const hookInput: SubagentStartInput = {
      hook_event_name: HookEvent.SubagentStart,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      agent_type: agentType,
      task_description: context.taskDescription,
      parent_agent_id: context.parentAgentId,
    };

    const hooks = this.getMatchingHooks(HookEvent.SubagentStart, {
      toolName: agentType,
    });

    if (hooks.length === 0) {
      return { proceed: true };
    }

    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeSubagentStartHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    agentType: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      taskDescription?: string;
      success: boolean;
      resultSummary?: string;
      error?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<SubagentStopHookResult> {
    if (!this.isEnabled()) {
      return { shouldStop: true };
    }

    // 构建 Hook 输入
    const hookInput: SubagentStopInput = {
      hook_event_name: HookEvent.SubagentStop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      agent_type: agentType,
      task_description: context.taskDescription,
      success: context.success,
      result_summary: context.resultSummary,
      error: context.error,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SubagentStop, {});

    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeSubagentStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing SubagentStop hooks:', err);
      return {
        shouldStop: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 TaskCompleted Hooks
   */
  async executeTaskCompletedHooks(
    taskId: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      taskDescription: string;
      resultSummary?: string;
      success: boolean;
      abortSignal?: AbortSignal;
    }
  ): Promise<TaskCompletedHookResult> {
    if (!this.isEnabled()) {
      return { allowCompletion: true };
    }

    const hookInput: TaskCompletedInput = {
      hook_event_name: HookEvent.TaskCompleted,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      task_id: taskId,
      task_description: context.taskDescription,
      result_summary: context.resultSummary,
      success: context.success,
    };

    const hooks = this.getMatchingHooks(HookEvent.TaskCompleted, {});

    if (hooks.length === 0) {
      return { allowCompletion: true };
    }

    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeTaskCompletedHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    toolName: string,
    toolUseId: string,
    toolInput: JsonObject,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PermissionRequestHookResult> {
    if (!this.isEnabled()) {
      return { decision: 'ask' };
    }

    const hookInput: PermissionRequestInput = {
      hook_event_name: HookEvent.PermissionRequest,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    const hooks = this.getMatchingHooks(HookEvent.PermissionRequest, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return { decision: 'ask' };
    }

    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executePermissionRequestHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    userPrompt: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      hasImages: boolean;
      imageCount: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<UserPromptSubmitHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    // 构建 Hook 输入
    const hookInput: UserPromptSubmitInput = {
      hook_event_name: HookEvent.UserPromptSubmit,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      user_prompt: userPrompt,
      has_images: context.hasImages,
      image_count: context.imageCount,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取 hooks (UserPromptSubmit 通常没有匹配器)
    const hooks = this.getMatchingHooks(HookEvent.UserPromptSubmit, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeUserPromptSubmitHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
  async executeSessionStartHooks(context: {
    projectDir: string;
    sessionId: string;
    permissionMode: PermissionMode;
    isResume: boolean;
    resumeSessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<SessionStartHookResult> {
    if (!this.isEnabled()) {
      return { proceed: true };
    }

    // 构建 Hook 输入
    const hookInput: SessionStartInput = {
      hook_event_name: HookEvent.SessionStart,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      is_resume: context.isResume,
      resume_session_id: context.resumeSessionId,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SessionStart, {});

    if (hooks.length === 0) {
      return { proceed: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeSessionStartHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    reason: SessionEndInput['reason'],
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<SessionEndHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: SessionEndInput = {
      hook_event_name: HookEvent.SessionEnd,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      reason,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SessionEnd, {});

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      // SessionEnd hooks 不阻塞，异步执行
      await this.executor.executeSessionEndHooks(hooks, hookInput, execContext);
      return {};
    } catch (err) {
      console.error('[HookManager] Error executing SessionEnd hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostToolUseFailure Hooks
   */
  async executePostToolUseFailureHooks(
    toolName: string,
    toolUseId: string,
    toolInput: JsonObject,
    error: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      errorType?: string;
      isInterrupt: boolean;
      isTimeout: boolean;
      abortSignal?: AbortSignal;
    }
  ): Promise<PostToolUseFailureHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: PostToolUseFailureInput = {
      hook_event_name: HookEvent.PostToolUseFailure,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      error,
      error_type: context.errorType,
      is_interrupt: context.isInterrupt,
      is_timeout: context.isTimeout,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(HookEvent.PostToolUseFailure, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executePostToolUseFailureHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUseFailure hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Notification Hooks
   */
  async executeNotificationHooks(
    notificationType: NotificationInput['notification_type'],
    message: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      title?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<NotificationHookResult> {
    if (!this.isEnabled()) {
      return { suppress: false, message };
    }

    // 构建 Hook 输入
    const hookInput: NotificationInput = {
      hook_event_name: HookEvent.Notification,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      notification_type: notificationType,
      title: context.title,
      message,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.Notification, {});

    if (hooks.length === 0) {
      return { suppress: false, message };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeNotificationHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing Notification hooks:', err);
      return {
        suppress: false,
        message,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Compaction Hooks
   */
  async executeCompactionHooks(
    trigger: 'manual' | 'auto',
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      messagesBefore: number;
      tokensBefore: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<CompactionHookResult> {
    if (!this.isEnabled()) {
      return { blockCompaction: false };
    }

    // 构建 Hook 输入
    const hookInput: CompactionInput = {
      hook_event_name: HookEvent.Compaction,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      trigger,
      messages_before: context.messagesBefore,
      tokens_before: context.tokensBefore,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.Compaction, {});

    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeCompactionHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { reason: string; error?: string; tool_name?: string },
    projectDir: string,
    sessionId: string,
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
      reason: params.reason,
      error: params.error,
      tool_name: params.tool_name,
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
      const results = await this.executor.executeStopFailureHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { trigger: 'manual' | 'auto'; messages_before: number; tokens_before: number },
    projectDir: string,
    sessionId: string,
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
      trigger: params.trigger,
      messages_before: params.messages_before,
      tokens_before: params.tokens_before,
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
      const results = await this.executor.executePreCompactHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
      trigger: 'manual' | 'auto';
      messages_before: number;
      messages_after: number;
      tokens_before: number;
      tokens_after: number;
      summary?: string;
    },
    projectDir: string,
    sessionId: string,
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
      trigger: params.trigger,
      messages_before: params.messages_before,
      messages_after: params.messages_after,
      tokens_before: params.tokens_before,
      tokens_after: params.tokens_after,
      summary: params.summary,
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
      const results = await this.executor.executePostCompactHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { server_name: string; resource_uri?: string; message?: string },
    projectDir: string,
    sessionId: string,
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
      server_name: params.server_name,
      resource_uri: params.resource_uri,
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
      const results = await this.executor.executeElicitationHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { server_name: string; response?: string; was_cancelled: boolean },
    projectDir: string,
    sessionId: string,
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
      server_name: params.server_name,
      response: params.response,
      was_cancelled: params.was_cancelled,
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
      const results = await this.executor.executeElicitationResultHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { changed_keys: string[]; source: 'file' | 'command' | 'environment' },
    projectDir: string,
    sessionId: string,
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
      source: params.source,
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
      const results = await this.executor.executeConfigChangeHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
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
    params: { old_cwd: string; new_cwd: string },
    projectDir: string,
    sessionId: string,
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
    params: { file_path: string; change_type: 'created' | 'modified' | 'deleted' },
    projectDir: string,
    sessionId: string,
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
    sessionId: string,
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
