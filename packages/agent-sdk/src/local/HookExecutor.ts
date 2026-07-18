/**
 * Hook Executor
 *
 * 负责执行单个或多个 Hooks
 */

import type { JsonObject, JsonValue } from '../types/common.js';
import { OutputParser } from './OutputParser.js';
import { SecureProcessExecutor } from './SecureProcessExecutor.js';
import {
  type CommandHook,
  type CompactionHookResult,
  type ConfigChangeHookResult,
  type CwdChangedHookResult,
  type ElicitationHookResult,
  type ElicitationResultHookResult,
  type FileChangedHookResult,
  type Hook,
  type HookExecutionContext,
  type HookExecutionResult,
  type HookInput,
  HookType,
  type InstructionsLoadedHookResult,
  type NotificationHookResult,
  type PermissionRequestHookResult,
  type PostCompactHookResult,
  type PostToolHookResult,
  type PostToolUseFailureHookResult,
  type PreCompactHookResult,
  type PreToolHookResult,
  type SessionEndHookResult,
  type SessionStartHookResult,
  type StopFailureHookResult,
  type StopHookResult,
  type SubagentStartHookResult,
  type SubagentStopHookResult,
  type TaskCompletedHookResult,
  type UserPromptSubmitHookResult
} from './hookTypes.js';

/**
 * Hook 执行器
 */
export class HookExecutor {
  private processExecutor = new SecureProcessExecutor();
  private outputParser = new OutputParser();

  /**
   * 执行 PreToolUse Hooks (串行)
   *
   * 串行执行的原因:
   * 1. 第一个 deny 需要立即中断
   * 2. updatedInput 需要累积应用
   */
  async executePreToolHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PreToolHookResult> {
    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    let cumulativeInput: JsonObject =
      'tool_input' in input ? input.tool_input : {};

    const warnings: string[] = [];

    // 串行执行
    for (const hook of hooks) {
      try {
        const hookInput = {
          ...input,
          ...(cumulativeInput && { tool_input: cumulativeInput }),
        };

        const result = await this.executeHook(hook, hookInput as HookInput, context);

        // 处理结果
        if (!result.success) {
          if (result.blocking) {
            // 阻塞错误 - 立即返回 deny
            return {
              decision: 'deny',
              reason: result.error,
            };
          }

          if (result.needsConfirmation) {
            // 需要确认 - 返回 ask
            return {
              decision: 'ask',
              reason: result.warning || result.error,
            };
          }

          // 非阻塞错误 - 记录警告,继续
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        // 检查 hookSpecificOutput
        const specific = result.output?.hookSpecificOutput;
        if (specific && 'permissionDecision' in specific) {
          switch (specific.permissionDecision) {
            case 'deny':
              return {
                decision: 'deny',
                reason: specific.permissionDecisionReason,
              };

            case 'ask':
              return {
                decision: 'ask',
                reason: specific.permissionDecisionReason,
              };

            case 'allow':
              // 继续执行
              break;
          }

          // 累积 updatedInput (仅 PreToolUseOutput 有此字段)
          if ('updatedInput' in specific && specific.updatedInput) {
            cumulativeInput = {
              ...cumulativeInput,
              ...specific.updatedInput,
            };
          }
        }
      } catch (err) {
        // Hook 执行异常,根据 failureBehavior 处理
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);

        if (context.config.failureBehavior === 'deny') {
          return {
            decision: 'deny',
            reason: errorMsg,
          };
        } else if (context.config.failureBehavior === 'ask') {
          return {
            decision: 'ask',
            reason: `Hook failed: ${errorMsg}. User confirmation required.`,
          };
        }
        // 'warn' behavior: continue to next hook
      }
    }

    // 所有 hooks 完成,没有 deny
    return {
      decision: 'allow',
      modifiedInput:
        cumulativeInput && Object.keys(cumulativeInput).length > 0
          ? cumulativeInput
          : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PostToolUse Hooks (并行)
   */
  async executePostToolHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PostToolHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success) {
        if (result.warning) {
          warnings.push(result.warning);
        }
        if (result.error) {
          warnings.push(result.error);
        }
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'additionalContext' in specific && specific.additionalContext) {
        additionalContexts.push(specific.additionalContext);
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Stop Hooks (并行)
   */
  async executeStopHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<StopHookResult> {
    if (hooks.length === 0) {
      return { shouldStop: false };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      shouldStop: false,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SubagentStart Hooks (并行)
   */
  async executeSubagentStartHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SubagentStartHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'additionalContext' in specific && specific.additionalContext) {
        additionalContexts.push(specific.additionalContext);
      }
    }

    return {
      proceed: true,
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SubagentStop Hooks (并行)
   */
  async executeSubagentStopHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SubagentStopHookResult> {
    if (hooks.length === 0) {
      return { shouldStop: false };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      shouldStop: false,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 TaskCompleted Hooks (串行)
   */
  async executeTaskCompletedHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<TaskCompletedHookResult> {
    if (hooks.length === 0) {
      return { allowCompletion: true };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'blockCompletion' in specific) {
          if (specific.blockCompletion) {
            return {
              allowCompletion: false,
              blockReason: specific.blockReason,
              warning: warnings.length > 0 ? warnings.join('\n') : undefined,
            };
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      allowCompletion: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Notification Hooks (并行)
   */
  async executeNotificationHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<NotificationHookResult> {
    if (hooks.length === 0) {
      return { suppress: false, message: '' };
    }

    const warnings: string[] = [];
    let suppressAll = false;
    let modifiedMessage = '';

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success) {
        if (result.warning) {
          warnings.push(result.warning);
        }
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific) {
        if ('suppress' in (specific as Record<string, unknown>) && (specific as Record<string, unknown>).suppress) {
          suppressAll = true;
        }
        if ('message' in (specific as Record<string, unknown>) && typeof (specific as Record<string, unknown>).message === 'string') {
          modifiedMessage = (specific as Record<string, unknown>).message as string;
        }
      }
    }

    return {
      suppress: suppressAll,
      message: modifiedMessage,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PermissionRequest Hooks (串行)
   */
  async executePermissionRequestHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PermissionRequestHookResult> {
    if (hooks.length === 0) {
      return { decision: 'ask' };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'permissionDecision' in specific) {
          switch (specific.permissionDecision) {
            case 'approve':
              return {
                decision: 'approve',
                reason: specific.permissionDecisionReason,
                warning: warnings.length > 0 ? warnings.join('\n') : undefined,
              };
            case 'deny':
              return {
                decision: 'deny',
                reason: specific.permissionDecisionReason,
                warning: warnings.length > 0 ? warnings.join('\n') : undefined,
              };
            case 'ask':
              // Continue to next hook
              break;
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      decision: 'ask',
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 UserPromptSubmit Hooks (串行)
   */
  async executeUserPromptSubmitHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<UserPromptSubmitHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    let updatedPrompt: string | undefined;
    const contextInjections: string[] = [];
    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific) {
          if ('proceed' in specific && !specific.proceed) {
            return { proceed: false, warning: warnings.length > 0 ? warnings.join('\n') : undefined };
          }
          if ('updatedPrompt' in specific && specific.updatedPrompt) {
            updatedPrompt = specific.updatedPrompt;
          }
          if ('contextInjection' in specific && specific.contextInjection) {
            contextInjections.push(specific.contextInjection);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      updatedPrompt,
      contextInjection:
        contextInjections.length > 0 ? contextInjections.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SessionStart Hooks (串行)
   */
  async executeSessionStartHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SessionStartHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];
    const env: Record<string, string> = {};

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'proceed' in specific && !specific.proceed) {
          return { proceed: false, warning: warnings.length > 0 ? warnings.join('\n') : undefined };
        }

        if (specific && 'env' in specific && specific.env) {
          Object.assign(env, specific.env);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      env: Object.keys(env).length > 0 ? env : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SessionEnd Hooks (并行)
   */
  async executeSessionEndHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SessionEndHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PostToolUseFailure Hooks (并行)
   */
  async executePostToolUseFailureHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PostToolUseFailureHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'additionalContext' in specific && specific.additionalContext) {
        additionalContexts.push(specific.additionalContext);
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 StopFailure Hooks (并行)
   */
  async executeStopFailureHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<StopFailureHookResult> {
    if (hooks.length === 0) {
      return { shouldRetry: false };
    }

    const warnings: string[] = [];
    let shouldRetry = false;
    let retryReason: string | undefined;

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'shouldRetry' in specific && specific.shouldRetry) {
        shouldRetry = true;
        retryReason = specific.retryReason || retryReason;
      }
    }

    return {
      shouldRetry,
      retryReason,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Compaction Hooks (并行)
   */
  async executeCompactionHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<CompactionHookResult> {
    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success) {
        if (result.warning) {
          warnings.push(result.warning);
        }
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'blockCompaction' in specific && specific.blockCompaction) {
        return {
          blockCompaction: true,
          blockReason: specific.blockReason,
          warning: warnings.length > 0 ? warnings.join('\n') : undefined,
        };
      }
    }

    return {
      blockCompaction: false,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PreCompact Hooks (并行)
   */
  async executePreCompactHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PreCompactHookResult> {
    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'blockCompaction' in specific && specific.blockCompaction) {
        return {
          blockCompaction: true,
          blockReason: specific.blockReason,
          warning: warnings.length > 0 ? warnings.join('\n') : undefined,
        };
      }
    }

    return {
      blockCompaction: false,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PostCompact Hooks (并行)
   */
  async executePostCompactHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PostCompactHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'additionalContext' in specific && specific.additionalContext) {
        additionalContexts.push(specific.additionalContext);
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Elicitation Hooks (串行)
   */
  async executeElicitationHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<ElicitationHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'proceed' in specific && !specific.proceed) {
          return { proceed: false, warning: warnings.length > 0 ? warnings.join('\n') : undefined };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 ElicitationResult Hooks (并行)
   */
  async executeElicitationResultHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<ElicitationResultHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      proceed: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 ConfigChange Hooks (并行，不阻塞)
   */
  async executeConfigChangeHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<ConfigChangeHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      proceed: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 CwdChanged Hooks (串行)
   *
   * 任何一个 hook 返回 proceed: false 就立即返回
   */
  async executeCwdChangedHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<CwdChangedHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'proceed' in (specific as Record<string, unknown>) && (specific as Record<string, unknown>).proceed === false) {
          return {
            proceed: false,
            warning: warnings.length > 0 ? warnings.join('\n') : undefined,
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 FileChanged Hooks (串行)
   *
   * 检查 action 字段，最后一个非默认值生效
   */
  async executeFileChangedHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<FileChangedHookResult> {
    if (hooks.length === 0) {
      return { action: 'reload' };
    }

    const warnings: string[] = [];
    let action: 'reload' | 'ignore' = 'reload';

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'action' in (specific as Record<string, unknown>) && (specific as Record<string, unknown>).action) {
          action = (specific as Record<string, unknown>).action as 'reload' | 'ignore';
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      action,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 InstructionsLoaded Hooks (串行)
   *
   * 累积 modified_instructions（最后一个生效）
   */
  async executeInstructionsLoadedHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<InstructionsLoadedHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];
    let modified_instructions: string | undefined;

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'modified_instructions' in (specific as Record<string, unknown>) && (specific as Record<string, unknown>).modified_instructions) {
          modified_instructions = (specific as Record<string, unknown>).modified_instructions as string;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      modified_instructions,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行单个 Hook
   */
  private async executeHook(
    hook: Hook,
    input: HookInput,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    if (hook.type === HookType.Command) {
      return this.executeCommandHook(hook, input, context);
    }

    // Prompt hooks 未来实现
    throw new Error(`Hook type ${hook.type} not yet implemented`);
  }

  /**
   * 执行命令 Hook
   */
  private async executeCommandHook(
    hook: CommandHook,
    input: HookInput,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const timeoutMs = (hook.timeout ?? context.config.defaultTimeout ?? 60) * 1000;

    try {
      const result = await this.processExecutor.execute(
        hook.command,
        input,
        context,
        timeoutMs
      );

      return this.outputParser.parse(result, hook, {
        timeoutBehavior: context.config.timeoutBehavior,
        failureBehavior: context.config.failureBehavior,
      });
    } catch (err) {
      return {
        success: false,
        blocking: false,
        error: err instanceof Error ? err.message : String(err),
        hook,
      };
    }
  }

  /**
   * 并发执行多个 Hooks (带并发限制)
   */
  private async executeHooksConcurrently(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext,
    maxConcurrent: number
  ): Promise<HookExecutionResult[]> {
    const results: Promise<HookExecutionResult>[] = [];
    const executing = new Set<Promise<void>>();

    for (const hook of hooks) {
      // 如果达到并发限制,等待一个完成
      if (executing.size >= maxConcurrent) {
        // 等待任意一个 Promise 完成
        await Promise.race(executing);
      }

      // 创建新的 hook 执行 Promise
      const promise = this.executeHook(hook, input, context).catch((err) => ({
        success: false,
        blocking: false,
        error: err instanceof Error ? err.message : String(err),
        hook,
      }));

      // 创建一个 void Promise 用于跟踪完成状态
      const tracker = promise
        .then(() => {
          executing.delete(tracker);
        })
        .catch(() => {
          executing.delete(tracker);
        });

      executing.add(tracker);
      results.push(promise);
    }

    // 等待所有剩余的 hooks 完成
    return Promise.all(results);
  }
}
