import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../agent/types.js';
import type { RuntimeHookRegistration } from '../runtime/index.js';
import type {
  ExecutionPipelineHookResult,
  ExecutionPipelineHooks,
} from '../tools/execution/ExecutionPipeline.js';
import type { ContentPart } from '../services/ChatServiceInterface.js';
import { cloneContentPart } from '../services/messageUtils.js';
import { HookEvent } from '../types/constants.js';
import type { PermissionMode } from '../types/common.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
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

  createExecutionPipelineHooks(): ExecutionPipelineHooks | undefined {
    const hasPreToolHooks = this.bus.has(HookEvent.PreToolUse);
    const hasPostToolHooks = this.bus.has(HookEvent.PostToolUse);
    const hasPostToolFailureHooks = this.bus.has(HookEvent.PostToolUseFailure);

    if (!hasPreToolHooks && !hasPostToolHooks && !hasPostToolFailureHooks) {
      return undefined;
    }

    return {
      beforeExecute: async ({ toolName, params }) => {
        if (!hasPreToolHooks) {
          return undefined;
        }

        let nextParams: Record<string, unknown> = params;
        const outputs = await this.bus.dispatch(
          HookEvent.PreToolUse,
          buildHookInput(this.options.sessionId, HookEvent.PreToolUse, {
            toolName,
            toolInput: nextParams,
          }),
        );

        for (const output of outputs) {
          if (output.action === 'abort' || output.action === 'skip') {
            return {
              action: output.action,
              reason: output.reason,
            } satisfies ExecutionPipelineHookResult;
          }

          if (output.modifiedInput && isRecord(output.modifiedInput)) {
            nextParams = { ...nextParams, ...output.modifiedInput };
          }
        }

        return nextParams === params ? undefined : { modifiedInput: nextParams };
      },
      afterExecute: async ({ toolName, params, result }) => {
        const event = result.success ? HookEvent.PostToolUse : HookEvent.PostToolUseFailure;
        if (!this.bus.has(event)) {
          return undefined;
        }

        let nextOutput: unknown = result.llmContent;
        const outputs = await this.bus.dispatch(
          event,
          buildHookInput(this.options.sessionId, event, {
            toolName,
            toolInput: params,
            toolOutput: nextOutput,
            error: result.success
              ? undefined
              : new Error(result.error?.message || `Tool "${toolName}" failed`),
          }),
        );

        for (const output of outputs) {
          if (output.action === 'abort' || output.action === 'skip') {
            return {
              action: output.action,
              reason: output.reason,
            } satisfies ExecutionPipelineHookResult;
          }

          if (output.modifiedOutput !== undefined) {
            nextOutput = output.modifiedOutput;
          }
        }

        return nextOutput === result.llmContent ? undefined : { modifiedOutput: nextOutput };
      },
    };
  }

  async applyPermissionRequestHooks(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      affectedPaths?: string[];
      toolKind?: 'readonly' | 'write' | 'execute';
      abortSignal?: AbortSignal;
    },
  ): Promise<{
    updatedInput: Record<string, unknown>;
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

        if (typeof output.modifiedInput === 'string') {
          nextMessage = this.replaceTextContent(nextMessage, output.modifiedInput);
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
      return async (input) => {
        const basePrompt = typeof input.userPrompt === 'string'
          ? input.userPrompt
          : '';
        const modifiedInput = basePrompt.trim() === ''
          ? hook.value
          : `${basePrompt}\n\n${hook.value}`;

        if (hook.once) {
          this.unregisterRuntimeHooks([registrationId]);
        }

        return {
          action: 'continue',
          modifiedInput,
        };
      };
    }

    return undefined;
  }
}
