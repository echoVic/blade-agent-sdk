import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../agent/types.js';
import { ConfigError } from '../errors/ConfigError.js';
import type { ModelContent } from '../model/message.js';
import type { HookTraceCollector } from '../observability/index.js';
import type { RuntimeHookRegistration } from '../runtime/index.js';
import { cloneContentPart } from '../services/messageUtils.js';
import type { HookCallback, HookInput } from '../session/types.js';
import type { ToolResult } from '../tools/types/result.js';
import { HookEvent } from '../types/constants.js';
import { type SessionId, ToolUseId } from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { PermissionResult } from '../types/permissions.js';
import { HookDispatcher } from './HookDispatcher.js';

interface HookRuntimeOptions {
  sessionId: SessionId;
  callbacks?: Partial<Record<HookEvent, HookCallback[]>>;
  hookTimeoutMs?: number;
  sessionEndHookTimeoutMs?: number;
}

export const DEFAULT_INLINE_HOOK_TIMEOUT_MS = 600_000;
export const DEFAULT_SESSION_END_HOOK_TIMEOUT_MS = 3_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function resolveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_DELAY_MS) {
    throw new ConfigError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hookInput(
  sessionId: SessionId,
  event: HookEvent,
  payload: Record<string, unknown>,
): HookInput {
  return { event, sessionId, ...payload };
}

function stringify(output: JsonValue): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function getText(message: UserMessageContent): string {
  if (typeof message === 'string') {
    return message;
  }
  return message
    .filter((part): part is Extract<ModelContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function replaceText(message: UserMessageContent, replacement: string): UserMessageContent {
  if (typeof message === 'string') {
    return replacement;
  }
  const images = message
    .filter(
      (part): part is Extract<ModelContent, { type: 'image_url' }> => part.type === 'image_url',
    )
    .map(cloneContentPart);
  return [
    ...(replacement === '' ? [] : [{ type: 'text', text: replacement } satisfies ModelContent]),
    ...images,
  ];
}

export interface PreToolUseRuntimeResult {
  toolUseId: ToolUseId;
  updatedInput: JsonObject;
  action?: 'continue' | 'skip' | 'abort';
  reason?: string;
}

export interface PostToolUseRuntimeResult {
  toolUseId: ToolUseId;
  result: ToolResult;
  action?: 'continue' | 'abort';
  reason?: string;
}

export class HookRuntime {
  private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>>;
  private readonly dispatcher: HookDispatcher;
  private readonly hookTimeoutMs: number;
  private readonly sessionEndHookTimeoutMs: number;
  private readonly runtimeHooks = new Map<string, { event: HookEvent; callback: HookCallback }>();
  private sessionEndCallbacksAttempted = false;
  private traceCollector?: HookTraceCollector;

  constructor(private readonly options: HookRuntimeOptions) {
    this.callbacks = Object.fromEntries(
      Object.entries(options.callbacks ?? {}).map(([event, callbacks]) => [
        event,
        [...(callbacks ?? [])],
      ]),
    );
    this.dispatcher = new HookDispatcher(this.callbacks);
    this.hookTimeoutMs = resolveTimeout(
      options.hookTimeoutMs,
      DEFAULT_INLINE_HOOK_TIMEOUT_MS,
      'hookTimeoutMs',
    );
    this.sessionEndHookTimeoutMs = resolveTimeout(
      options.sessionEndHookTimeoutMs,
      DEFAULT_SESSION_END_HOOK_TIMEOUT_MS,
      'sessionEndHookTimeoutMs',
    );
  }

  getCallbacks(): Partial<Record<HookEvent, HookCallback[]>> {
    return this.callbacks;
  }

  hasPendingCallbackCleanup(): boolean {
    return this.dispatcher.hasPendingCleanup();
  }

  setTraceCollector(traceCollector: HookTraceCollector | undefined): void {
    this.traceCollector = traceCollector;
  }

  registerRuntimeHooks(hooks: RuntimeHookRegistration[]): string[] {
    const ids: string[] = [];
    for (const hook of hooks) {
      const id = `runtime-hook-${nanoid()}`;
      const callback = this.createRuntimeHookCallback(id, hook);
      if (!callback) {
        continue;
      }
      const callbacks = this.callbacks[hook.event] ?? [];
      callbacks.push(callback);
      this.callbacks[hook.event] = callbacks;
      this.runtimeHooks.set(id, { event: hook.event, callback });
      ids.push(id);
    }
    return ids;
  }

  unregisterRuntimeHooks(ids: string[]): void {
    for (const id of ids) {
      const registration = this.runtimeHooks.get(id);
      if (!registration) {
        continue;
      }
      const callbacks = this.callbacks[registration.event];
      if (callbacks) {
        this.callbacks[registration.event] = callbacks.filter(
          (callback) => callback !== registration.callback,
        );
      }
      this.runtimeHooks.delete(id);
    }
  }

  async applyPreToolUse(
    toolName: string,
    input: JsonObject,
    options: { toolUseId?: ToolUseId; abortSignal?: AbortSignal } = {},
  ): Promise<PreToolUseRuntimeResult> {
    const toolUseId = options.toolUseId ?? ToolUseId(`tool_${nanoid()}`);
    let updatedInput = { ...input };
    const outputs = await this.dispatch(
      HookEvent.PreToolUse,
      { toolName, toolInput: updatedInput },
      options.abortSignal,
    );

    for (const output of outputs) {
      if (output.action === 'abort' || output.action === 'skip') {
        return { toolUseId, updatedInput, action: output.action, reason: output.reason };
      }
      if (isRecord(output.modifiedInput)) {
        updatedInput = { ...updatedInput, ...output.modifiedInput };
      }
    }
    return { toolUseId, updatedInput };
  }

  async applyPostToolUse(
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    options: { toolUseId?: ToolUseId; abortSignal?: AbortSignal } = {},
  ): Promise<PostToolUseRuntimeResult> {
    return this.applyPostToolCallbacks(
      HookEvent.PostToolUse,
      toolName,
      input,
      result,
      options.toolUseId ?? ToolUseId(`tool_${nanoid()}`),
      options.abortSignal,
    );
  }

  async applyPostToolUseFailure(
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    options: { toolUseId?: ToolUseId; abortSignal?: AbortSignal } = {},
  ): Promise<PostToolUseRuntimeResult> {
    return this.applyPostToolCallbacks(
      HookEvent.PostToolUseFailure,
      toolName,
      input,
      result,
      options.toolUseId ?? ToolUseId(`tool_${nanoid()}`),
      options.abortSignal,
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
  ): Promise<{ updatedInput: JsonObject; decision?: PermissionResult }> {
    let updatedInput = input;
    const outputs = await this.dispatch(
      HookEvent.PermissionRequest,
      {
        toolName,
        toolInput: updatedInput,
        affectedPaths: options.affectedPaths,
        toolKind: options.toolKind,
      },
      options.abortSignal,
    );

    for (const output of outputs) {
      if (isRecord(output.modifiedInput)) {
        updatedInput = { ...updatedInput, ...output.modifiedInput };
      }
      if (output.action === 'abort' || output.action === 'skip') {
        return {
          updatedInput,
          decision: {
            behavior: 'deny',
            message: output.reason || `Tool "${toolName}" was blocked by hook`,
            interrupt: output.action === 'abort',
          },
        };
      }
    }
    return { updatedInput };
  }

  async applyUserPromptSubmit(
    message: UserMessageContent,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<UserMessageContent> {
    const imageCount =
      typeof message === 'string' ? 0 : message.filter((part) => part.type === 'image_url').length;
    let updated = message;
    const outputs = await this.dispatch(
      HookEvent.UserPromptSubmit,
      {
        userPrompt: getText(message),
        hasImages: imageCount > 0,
        imageCount,
      },
      options.abortSignal,
    );

    for (const output of outputs) {
      if (output.action === 'abort') {
        throw new Error(output.reason || 'Prompt submission aborted by hook');
      }
      if (typeof output.modifiedInput?.userPrompt === 'string') {
        updated = replaceText(updated, output.modifiedInput.userPrompt);
      }
    }
    return updated;
  }

  runSessionStart(payload: {
    isResume: boolean;
    resumeSessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    return this.runGroup(HookEvent.SessionStart, payload, payload.abortSignal);
  }

  runTaskCompleted(payload: {
    taskId: string;
    taskDescription: string;
    resultSummary?: string;
    success: boolean;
    abortSignal?: AbortSignal;
    [key: string]: unknown;
  }): Promise<void> {
    return this.runGroup(HookEvent.TaskCompleted, payload, payload.abortSignal);
  }

  async runSessionEnd(payload: {
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
  }): Promise<void> {
    payload.abortSignal?.throwIfAborted();
    if (this.sessionEndCallbacksAttempted) {
      return;
    }
    this.sessionEndCallbacksAttempted = true;
    await this.runGroup(
      HookEvent.SessionEnd,
      payload,
      payload.abortSignal,
      this.sessionEndHookTimeoutMs,
    );
  }

  private async runGroup(
    event: HookEvent,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.hookTimeoutMs,
  ): Promise<void> {
    const outputs = await this.dispatch(event, payload, signal, timeoutMs);
    const abort = outputs.find((output) => output.action === 'abort');
    if (abort) {
      throw new Error(abort.reason || `Hook ${event} aborted`);
    }
  }

  private async applyPostToolCallbacks(
    event: typeof HookEvent.PostToolUse | typeof HookEvent.PostToolUseFailure,
    toolName: string,
    input: JsonObject,
    result: ToolResult,
    toolUseId: ToolUseId,
    signal?: AbortSignal,
  ): Promise<PostToolUseRuntimeResult> {
    let output: JsonValue = result.model;
    const outputs = await this.dispatch(
      event,
      {
        toolName,
        toolInput: input,
        toolOutput: output,
        error: result.status === 'success' ? undefined : new Error(result.error.message),
      },
      signal,
    );

    for (const hookResult of outputs) {
      if (hookResult.action === 'abort') {
        return { toolUseId, result, action: 'abort', reason: hookResult.reason };
      }
      if (hookResult.modifiedOutput !== undefined) {
        output = hookResult.modifiedOutput;
      }
    }
    return {
      toolUseId,
      result: output === result.model ? result : { ...result, model: stringify(output) },
    };
  }

  private async dispatch(
    event: HookEvent,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.hookTimeoutMs,
  ) {
    signal?.throwIfAborted();
    if (!this.dispatcher.has(event)) {
      return [];
    }
    const input = hookInput(this.options.sessionId, event, payload);
    const spanId = this.traceCollector?.recordHookStart(event, input);
    try {
      const outputs = await this.dispatcher.dispatch(event, input, { signal, timeoutMs });
      if (spanId) {
        this.traceCollector?.recordHookEnd(spanId, {
          outputCount: outputs.length,
          actions: outputs.map((output) => output.action),
        });
      }
      return outputs;
    } catch (error) {
      if (spanId) {
        this.traceCollector?.recordHookError(spanId, error);
      }
      throw error;
    }
  }

  private createRuntimeHookCallback(
    registrationId: string,
    hook: RuntimeHookRegistration,
  ): HookCallback | undefined {
    if (hook.type !== 'append_prompt' || !hook.value) {
      return undefined;
    }
    const value = hook.value;
    return async (input) => {
      const prompt = typeof input.userPrompt === 'string' ? input.userPrompt : '';
      if (hook.once) {
        this.unregisterRuntimeHooks([registrationId]);
      }
      return {
        action: 'continue',
        modifiedInput: {
          userPrompt: prompt.trim() === '' ? value : `${prompt}\n\n${value}`,
        },
      };
    };
  }
}
