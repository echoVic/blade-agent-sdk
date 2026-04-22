import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../agent/types.js';
import type { RuntimeHookRegistration } from '../runtime/index.js';
import type { ContentPart } from '../services/ChatServiceInterface.js';
import { cloneContentPart } from '../services/messageUtils.js';
import type { ToolResult } from '../tools/types/index.js';
import { HookEvent } from '../types/constants.js';
import type { JsonObject, JsonValue, PermissionMode } from '../types/common.js';
import type { PermissionResult } from '../types/permissions.js';
import type { HookCallback, HookInput } from '../session/types.js';
import { HookManager } from './HookManager.js';
import { HookBus } from './HookBus.js';

interface HookRuntimeOptions {
  sessionId: string;
  permissionMode: PermissionMode;
  callbacks?: Partial<Record<HookEvent, HookCallback[]>>;
  resolveProjectDir: () => string | undefined;
  hookManager?: HookManager;
}

export interface PreToolUseRuntimeResult {
  toolUseId: string;
  updatedInput: JsonObject;
  action?: 'continue' | 'skip' | 'abort';
  reason?: string;
  needsConfirmation?: boolean;
}

export interface PostToolUseRuntimeResult {
  toolUseId: string;
  result: ToolResult;
  action?: 'continue' | 'abort';
  reason?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildHookInput(
  sessionId: string,
  event: HookEvent,
  payload: Record<string, unknown>,
): HookInput {
  return {
    event,
    sessionId,
    ...payload,
  };
}

export class HookRuntime {
  private readonly bus: HookBus;
  private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>>;
  private readonly hookManager: HookManager;
  private readonly runtimeHookRegistrations = new Map<string, {
    event: HookEvent;
    callback: HookCallback;
  }>();

  constructor(private readonly options: HookRuntimeOptions) {
    this.callbacks = Object.fromEntries(
      Object.entries(options.callbacks ?? {}).map(([event, callbacks]) => [
        event,
        [...(callbacks ?? [])],
      ]),
    ) as Partial<Record<HookEvent, HookCallback[]>>;
    this.bus = new HookBus(this.callbacks);
    this.hookManager = options.hookManager ?? HookManager.getInstance();
  }

  getCallbacks(): Partial<Record<HookEvent, HookCallback[]>> {
    return this.callbacks;
  }

  registerRuntimeHooks(hooks: RuntimeHookRegistration[]): string[] {
    const registrationIds: string[] = [];

    for (const hook of hooks) {
      const registrationId = `runtime-hook-${nanoid()}`;
      const callback = this.createRuntimeHookCallback(registrationId, hook);
      if (!callback) {
        continue;
      }

      const bucket = this.callbacks[hook.event] ?? [];
      bucket.push(callback);
      this.callbacks[hook.event] = bucket;
      this.runtimeHookRegistrations.set(registrationId, {
        event: hook.event,
        callback,
      });
      registrationIds.push(registrationId);
    }

    return registrationIds;
  }

  unregisterRuntimeHooks(registrationIds: string[]): void {
    for (const registrationId of registrationIds) {
      const registration = this.runtimeHookRegistrations.get(registrationId);
      if (!registration) {
        continue;
      }

      const bucket = this.callbacks[registration.event];
      if (bucket) {
        this.callbacks[registration.event] = bucket.filter((hook) => hook !== registration.callback);
      }
      this.runtimeHookRegistrations.delete(registrationId);
    }
  }

  async applyPreToolUse(
    toolName: string,
    input: JsonObject,
    options: {
      toolUseId?: string;
      permissionMode?: PermissionMode;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PreToolUseRuntimeResult> {
    const toolUseId = options.toolUseId ?? `tool_${nanoid()}`;
    let nextInput = { ...input };

    if (this.bus.has(HookEvent.PreToolUse)) {
      const outputs = await this.bus.dispatch(
        HookEvent.PreToolUse,
        buildHookInput(this.options.sessionId, HookEvent.PreToolUse, {
          toolName,
          toolInput: nextInput,
        }),
      );

      for (const output of outputs) {
        if (output.action === 'abort' || output.action === 'skip') {
          return {
            toolUseId,
            updatedInput: nextInput,
            action: output.action,
            reason: output.reason,
          };
        }

        if (output.modifiedInput && isRecord(output.modifiedInput)) {
          nextInput = { ...nextInput, ...output.modifiedInput };
        }
      }
    }

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return { toolUseId, updatedInput: nextInput };
    }

    const managerResult = await this.hookManager.executePreToolHooks(
      toolName,
      toolUseId,
      nextInput,
      {
        projectDir,
        sessionId: this.options.sessionId,
        permissionMode: options.permissionMode ?? this.options.permissionMode,
        abortSignal: options.abortSignal,
      },
    );

    if (managerResult.modifiedInput) {
      nextInput = { ...nextInput, ...managerResult.modifiedInput };
    }
    if (managerResult.warning) {
      console.warn(`[HookRuntime] PreToolUse warning: ${managerResult.warning}`);
    }
    if (managerResult.decision === 'deny') {
      return {
        toolUseId,
        updatedInput: nextInput,
        action: 'abort',
        reason: managerResult.reason || `Tool "${toolName}" was blocked by hook manager`,
      };
    }
    if (managerResult.decision === 'ask') {
      return {
        toolUseId,
        updatedInput: nextInput,
        needsConfirmation: true,
        reason: managerResult.reason || `Tool "${toolName}" requires confirmation from hooks`,
      };
    }

    return { toolUseId, updatedInput: nextInput };
  }

  async applyPostToolUse(
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    options: {
      toolUseId?: string;
      permissionMode?: PermissionMode;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PostToolUseRuntimeResult> {
    const toolUseId = options.toolUseId ?? `tool_${nanoid()}`;
    let nextResult = result;

    const projectDir = this.options.resolveProjectDir();
    if (projectDir) {
      const managerResult = await this.hookManager.executePostToolHooks(
        toolName,
        toolUseId,
        input,
        nextResult,
        {
          projectDir,
          sessionId: this.options.sessionId,
          permissionMode: options.permissionMode ?? this.options.permissionMode,
          abortSignal: options.abortSignal,
        },
      );

      nextResult = this.applyManagerPostToolResult(nextResult, managerResult);
    }

    return this.applyPostToolCallbacks(
      HookEvent.PostToolUse,
      toolName,
      input,
      nextResult,
      toolUseId,
    );
  }

  async applyPostToolUseFailure(
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    options: {
      toolUseId?: string;
      permissionMode?: PermissionMode;
      errorType?: string;
      isInterrupt?: boolean;
      isTimeout?: boolean;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PostToolUseRuntimeResult> {
    const toolUseId = options.toolUseId ?? `tool_${nanoid()}`;
    let nextResult = result;

    const projectDir = this.options.resolveProjectDir();
    if (projectDir) {
      const managerResult = await this.hookManager.executePostToolUseFailureHooks(
        toolName,
        toolUseId,
        input,
        result.error?.message || `Tool "${toolName}" failed`,
        {
          projectDir,
          sessionId: this.options.sessionId,
          permissionMode: options.permissionMode ?? this.options.permissionMode,
          errorType: options.errorType,
          isInterrupt: options.isInterrupt ?? false,
          isTimeout: options.isTimeout ?? false,
          abortSignal: options.abortSignal,
        },
      );

      if (managerResult.additionalContext) {
        nextResult = {
          ...nextResult,
          llmContent: `${nextResult.llmContent}\n\n${managerResult.additionalContext}`,
        };
      }
      if (managerResult.warning) {
        console.warn(`[HookRuntime] PostToolUseFailure warning: ${managerResult.warning}`);
      }
    }

    return this.applyPostToolCallbacks(
      HookEvent.PostToolUseFailure,
      toolName,
      input,
      nextResult,
      toolUseId,
    );
  }

  async applyPermissionRequestHooks(
    toolName: string,
    input: JsonObject,
    options: {
      affectedPaths?: string[];
      toolKind?: 'readonly' | 'write' | 'execute';
      abortSignal?: AbortSignal;
    },
  ): Promise<{
    updatedInput: JsonObject;
    decision?: PermissionResult;
  }> {
    let nextInput = input;

    if (this.bus.has(HookEvent.PermissionRequest)) {
      const outputs = await this.bus.dispatch(
        HookEvent.PermissionRequest,
        buildHookInput(this.options.sessionId, HookEvent.PermissionRequest, {
          toolName,
          toolInput: nextInput,
          affectedPaths: options.affectedPaths,
          toolKind: options.toolKind,
        }),
      );

      for (const output of outputs) {
        if (output.modifiedInput && isRecord(output.modifiedInput)) {
          nextInput = { ...nextInput, ...output.modifiedInput };
        }
        if (output.action === 'abort' || output.action === 'skip') {
          return {
            updatedInput: nextInput,
            decision: {
              behavior: 'deny',
              message: output.reason || `Tool "${toolName}" was blocked by hook`,
              interrupt: output.action === 'abort',
            },
          };
        }
      }
    }

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return { updatedInput: nextInput };
    }

    const managerResult = await this.hookManager.executePermissionRequestHooks(
      toolName,
      `permission_${toolName}_${Date.now()}`,
      nextInput,
      {
        projectDir,
        sessionId: this.options.sessionId,
        permissionMode: this.options.permissionMode,
        abortSignal: options.abortSignal,
      },
    );

    if (managerResult.decision === 'deny') {
      return {
        updatedInput: nextInput,
        decision: {
          behavior: 'deny',
          message: managerResult.reason || `Tool "${toolName}" was denied by hook manager`,
        },
      };
    }

    if (managerResult.decision === 'approve') {
      return {
        updatedInput: nextInput,
        decision: { behavior: 'allow' },
      };
    }

    return { updatedInput: nextInput };
  }

  async applyUserPromptSubmit(
    message: UserMessageContent,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<UserMessageContent> {
    let nextMessage = message;

    if (this.bus.has(HookEvent.UserPromptSubmit)) {
      const imageMeta = this.getImageMetadata(nextMessage);
      const outputs = await this.bus.dispatch(
        HookEvent.UserPromptSubmit,
        buildHookInput(this.options.sessionId, HookEvent.UserPromptSubmit, {
          userPrompt: this.getTextContent(nextMessage),
          hasImages: imageMeta.hasImages,
          imageCount: imageMeta.imageCount,
        }),
      );

      for (const output of outputs) {
        if (output.action === 'abort') {
          throw new Error(output.reason || 'Prompt submission aborted by hook');
        }

        if (output.modifiedInput != null) {
          // Legacy path: older hooks may return a bare string as modifiedInput
          if (typeof output.modifiedInput === 'string') {
            nextMessage = this.replaceTextContent(nextMessage, output.modifiedInput);
          } else if (typeof output.modifiedInput.userPrompt === 'string') {
            nextMessage = this.replaceTextContent(nextMessage, output.modifiedInput.userPrompt);
          }
        }
      }
    }

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return nextMessage;
    }

    const imageMeta = this.getImageMetadata(nextMessage);
    const managerResult = await this.hookManager.executeUserPromptSubmitHooks(
      this.getTextContent(nextMessage),
      {
        projectDir,
        sessionId: this.options.sessionId,
        permissionMode: this.options.permissionMode,
        hasImages: imageMeta.hasImages,
        imageCount: imageMeta.imageCount,
        abortSignal: options.abortSignal,
      },
    );

    if (!managerResult.proceed) {
      throw new Error(managerResult.warning || 'Prompt submission aborted by hook manager');
    }

    if (managerResult.updatedPrompt) {
      nextMessage = this.replaceTextContent(nextMessage, managerResult.updatedPrompt);
    }

    if (managerResult.contextInjection) {
      nextMessage = this.appendTextContent(nextMessage, managerResult.contextInjection);
    }

    return nextMessage;
  }

  async runSessionStart(
    payload: { isResume: boolean; resumeSessionId?: string; abortSignal?: AbortSignal },
  ): Promise<void> {
    await this.runCallbackGroup(HookEvent.SessionStart, payload);

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return;
    }

    const result = await this.hookManager.executeSessionStartHooks({
      projectDir,
      sessionId: this.options.sessionId,
      permissionMode: this.options.permissionMode,
      isResume: payload.isResume,
      resumeSessionId: payload.resumeSessionId,
      abortSignal: payload.abortSignal,
    });
    if (!result.proceed) {
      throw new Error(result.warning || 'Session start aborted by hook manager');
    }
  }

  async runTaskCompleted(
    payload: {
      taskId: string;
      taskDescription: string;
      resultSummary?: string;
      success: boolean;
      abortSignal?: AbortSignal;
      [key: string]: unknown;
    },
  ): Promise<void> {
    await this.runCallbackGroup(HookEvent.TaskCompleted, payload);

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return;
    }

    const result = await this.hookManager.executeTaskCompletedHooks(payload.taskId, {
      projectDir,
      sessionId: this.options.sessionId,
      permissionMode: this.options.permissionMode,
      taskDescription: payload.taskDescription,
      resultSummary: payload.resultSummary,
      success: payload.success,
      abortSignal: payload.abortSignal,
    });
    if (!result.allowCompletion) {
      throw new Error(result.blockReason || 'Task completion blocked by hook manager');
    }
  }

  async runSessionEnd(
    payload: {
      reason:
        | 'error'
        | 'other'
        | 'user_exit'
        | 'max_turns'
        | 'idle_timeout'
        | 'ctrl_c'
        | 'esc'
        | 'clear'
        | 'logout';
      abortSignal?: AbortSignal;
    },
  ): Promise<void> {
    await this.runCallbackGroup(HookEvent.SessionEnd, payload);

    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return;
    }

    await this.hookManager.executeSessionEndHooks(payload.reason, {
      projectDir,
      sessionId: this.options.sessionId,
      permissionMode: this.options.permissionMode,
      abortSignal: payload.abortSignal,
    });
  }

  async executeStopCheck(
    payload: {
      reason: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<{ shouldStop: boolean; continueReason?: string; warning?: string }> {
    const projectDir = this.options.resolveProjectDir();
    if (!projectDir) {
      return { shouldStop: true };
    }

    return this.hookManager.executeStopHooks({
      projectDir,
      sessionId: this.options.sessionId,
      permissionMode: this.options.permissionMode,
      reason: payload.reason,
      abortSignal: payload.abortSignal,
    });
  }

  private async runCallbackGroup(
    event: HookEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.bus.has(event)) {
      return;
    }

    const outputs = await this.bus.dispatch(
      event,
      buildHookInput(this.options.sessionId, event, payload),
    );
    for (const output of outputs) {
      if (output.action === 'abort') {
        throw new Error(output.reason || `Hook ${event} aborted`);
      }
    }
  }

  private applyManagerPostToolResult(result: ToolResult, hookResult: {
    additionalContext?: string;
    modifiedOutput?: JsonValue;
    warning?: string;
  }): ToolResult {
    let nextResult = result;

    if (hookResult.warning) {
      console.warn(`[HookRuntime] Hook warning: ${hookResult.warning}`);
    }

    if (hookResult.additionalContext) {
      const currentContent = nextResult.llmContent || '';
      nextResult = {
        ...nextResult,
        llmContent: `${currentContent}\n\n---\n**Hook Context:**\n${hookResult.additionalContext}`,
      };
    }

    if (hookResult.modifiedOutput !== undefined) {
      const renderedOutput = this.stringifyHookOutput(hookResult.modifiedOutput);
      nextResult = {
        ...nextResult,
        llmContent: renderedOutput,
      };
    }

    return nextResult;
  }

  private async applyPostToolCallbacks(
    event: typeof HookEvent.PostToolUse | typeof HookEvent.PostToolUseFailure,
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    toolUseId: string,
  ): Promise<PostToolUseRuntimeResult> {
    if (!this.bus.has(event)) {
      return { toolUseId, result };
    }

    let nextResult = result;
    let nextOutput: string | object | JsonValue = result.llmContent;
    const outputs = await this.bus.dispatch(
      event,
      buildHookInput(this.options.sessionId, event, {
        toolName,
        toolInput: input,
        toolOutput: nextOutput,
        error: result.success
          ? undefined
          : new Error(result.error?.message || `Tool "${toolName}" failed`),
      }),
    );

    for (const output of outputs) {
      if (output.action === 'abort') {
        return {
          toolUseId,
          result: nextResult,
          action: 'abort',
          reason: output.reason,
        };
      }

      if (output.modifiedOutput !== undefined) {
        nextOutput = output.modifiedOutput;
      }
    }

    if (nextOutput !== result.llmContent) {
      const renderedOutput = this.stringifyHookOutput(nextOutput);
      nextResult = {
        ...nextResult,
        llmContent: renderedOutput,
      };
    }

    return { toolUseId, result: nextResult };
  }

  private stringifyHookOutput(output: string | object | JsonValue): string {
    if (typeof output === 'string') {
      return output;
    }

    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private getTextContent(message: UserMessageContent): string {
    if (typeof message === 'string') {
      return message;
    }

    return message
      .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  private replaceTextContent(message: UserMessageContent, replacement: string): UserMessageContent {
    if (typeof message === 'string') {
      return replacement;
    }

    const imageParts = message
      .filter((part): part is Extract<ContentPart, { type: 'image_url' }> => part.type === 'image_url')
      .map(cloneContentPart);

    return [
      ...(replacement === '' ? [] : [{ type: 'text', text: replacement } satisfies ContentPart]),
      ...imageParts,
    ];
  }

  private appendTextContent(message: UserMessageContent, extra: string): UserMessageContent {
    if (typeof message === 'string') {
      return `${message}\n\n${extra}`;
    }

    return [...message, { type: 'text', text: `\n\n${extra}` }];
  }

  private getImageCount(message: UserMessageContent): number {
    if (typeof message === 'string') {
      return 0;
    }

    return message.filter((part) => part.type === 'image_url').length;
  }

  private getImageMetadata(message: UserMessageContent): { hasImages: boolean; imageCount: number } {
    const imageCount = this.getImageCount(message);
    return {
      hasImages: imageCount > 0,
      imageCount,
    };
  }

  private createRuntimeHookCallback(
    registrationId: string,
    hook: RuntimeHookRegistration,
  ): HookCallback | undefined {
    if (hook.event === HookEvent.UserPromptSubmit && hook.type === 'append_prompt' && hook.value) {
      const hookValue = hook.value;
      return async (input) => {
        const basePrompt = typeof input.userPrompt === 'string'
          ? input.userPrompt
          : '';
        const modifiedPrompt = basePrompt.trim() === ''
          ? hookValue
          : `${basePrompt}\n\n${hookValue}`;

        if (hook.once) {
          this.unregisterRuntimeHooks([registrationId]);
        }

        return {
          action: 'continue',
          modifiedInput: { userPrompt: modifiedPrompt },
        };
      };
    }

    return undefined;
  }
}
