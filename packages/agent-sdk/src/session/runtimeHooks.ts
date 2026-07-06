import type { AgentHookPort } from '@blade-ai/agent';
import type { ModelRequest } from '@blade-ai/ai';
import { HookEvent } from '../types/constants.js';
import type { HookCallback, SessionHookEvent } from './types.js';

export interface PackageLocalRuntimeHookManagerPort {
  enable(): void;
}

export interface PackageLocalRuntimeHookRuntimePort extends PackageLocalRuntimeHookManagerPort {
  setTraceCollector?(collector: unknown): void;
  createAgentHookPort?(): AgentHookPort;
  runSessionStart?(payload: PackageLocalSessionStartHookPayload): Promise<void> | void;
  runSessionEnd?(payload: PackageLocalSessionEndHookPayload): Promise<void> | void;
}

export interface PackageLocalRuntimeHooksInitializationOptions {
  hookManager: PackageLocalRuntimeHookManagerPort;
  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
}

export interface PackageLocalRuntimeHookOperations {
  initialize(): void;
}

export interface PackageLocalRuntimeTraceCollectorStreamOptions<TChunk> {
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  traceCollector: unknown;
  stream: AsyncIterable<TChunk>;
}

export interface PackageLocalHookTraceCollector {
  recordHookStart?(event: HookEvent, payload: Record<string, unknown>): string;
  recordHookEnd?(spanId: string, payload?: Record<string, unknown>): void;
  recordHookError?(spanId: string, error: unknown): void;
}

export interface PackageLocalRuntimeHookRuntimeOptions {
  sessionId: string;
  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
}

export interface PackageLocalSessionStartHookPayload {
  isResume: boolean;
  resumeSessionId?: string;
  model: string;
  provider: string;
  abortSignal?: AbortSignal;
}

export type PackageLocalSessionEndReason =
  | 'error'
  | 'other'
  | 'user_exit'
  | 'max_turns'
  | 'idle_timeout'
  | 'ctrl_c'
  | 'esc'
  | 'clear'
  | 'logout';

export interface PackageLocalSessionEndHookPayload {
  reason: PackageLocalSessionEndReason;
  abortSignal?: AbortSignal;
}

export function initializePackageLocalRuntimeHooks(
  options: PackageLocalRuntimeHooksInitializationOptions,
): void {
  if (options.hooks && Object.keys(options.hooks).length > 0) {
    options.hookManager.enable();
  }
}

export function createPackageLocalRuntimeHookOperations(
  options: PackageLocalRuntimeHooksInitializationOptions,
): PackageLocalRuntimeHookOperations {
  return {
    initialize() {
      initializePackageLocalRuntimeHooks(options);
    },
  };
}

export function createPackageLocalRuntimeHookRuntime(
  options: PackageLocalRuntimeHookRuntimeOptions,
): PackageLocalRuntimeHookRuntimePort {
  let traceCollector: PackageLocalHookTraceCollector | undefined;

  return {
    enable() {},
    setTraceCollector(collector) {
      traceCollector = collector as PackageLocalHookTraceCollector | undefined;
    },
    createAgentHookPort() {
      return {
        async beforeModel(request, context) {
          if (context.step !== 1) {
            return request;
          }

          return applyPackageLocalUserPromptSubmitHooks({
            request,
            sessionId: options.sessionId,
            callbacks: options.hooks?.[HookEvent.UserPromptSubmit] ?? [],
            traceCollector,
          });
        },
      };
    },
    async runSessionStart(payload) {
      await runPackageLocalHookCallbacks({
        event: HookEvent.SessionStart,
        sessionId: options.sessionId,
        callbacks: options.hooks?.[HookEvent.SessionStart] ?? [],
        payload,
        traceCollector,
      });
    },
    async runSessionEnd(payload) {
      await runPackageLocalHookCallbacks({
        event: HookEvent.SessionEnd,
        sessionId: options.sessionId,
        callbacks: options.hooks?.[HookEvent.SessionEnd] ?? [],
        payload,
        traceCollector,
      });
    },
  };
}

interface PackageLocalHookCallbackRunOptions {
  event: SessionHookEvent;
  sessionId: string;
  callbacks: readonly HookCallback[];
  payload: object;
  traceCollector?: PackageLocalHookTraceCollector;
}

async function runPackageLocalHookCallbacks(
  options: PackageLocalHookCallbackRunOptions,
): Promise<void> {
  for (const callback of options.callbacks) {
    const payload = {
      event: options.event,
      sessionId: options.sessionId,
      ...options.payload,
    };
    const spanId = options.traceCollector?.recordHookStart?.(options.event, payload);

    try {
      const output = await callback(payload);
      if (spanId) {
        options.traceCollector?.recordHookEnd?.(spanId, {
          action: output.action,
          reason: output.reason,
        });
      }
      if (output.action === 'abort') {
        throw new Error(output.reason || `${options.event} aborted by hook`);
      }
    } catch (error) {
      if (spanId) {
        options.traceCollector?.recordHookError?.(spanId, error);
      }
      throw error;
    }
  }
}

interface PackageLocalUserPromptSubmitHookOptions {
  request: ModelRequest;
  sessionId: string;
  callbacks: readonly HookCallback[];
  traceCollector?: PackageLocalHookTraceCollector;
}

async function applyPackageLocalUserPromptSubmitHooks(
  options: PackageLocalUserPromptSubmitHookOptions,
): Promise<ModelRequest> {
  if (options.callbacks.length === 0) {
    return options.request;
  }

  const userMessageIndex = findLastUserMessageIndex(options.request);
  const userMessage = userMessageIndex === -1
    ? undefined
    : options.request.messages[userMessageIndex];
  if (!userMessage) {
    return options.request;
  }

  let nextPrompt = userMessage.content;

  for (const callback of options.callbacks) {
    const payload = {
      event: HookEvent.UserPromptSubmit,
      sessionId: options.sessionId,
      userPrompt: nextPrompt,
      hasImages: false,
      imageCount: 0,
    };
    const spanId = options.traceCollector?.recordHookStart?.(HookEvent.UserPromptSubmit, payload);

    try {
      const output = await callback(payload);
      if (spanId) {
        options.traceCollector?.recordHookEnd?.(spanId, {
          action: output.action,
          reason: output.reason,
        });
      }

      if (output.action === 'abort') {
        throw new Error(output.reason || 'Prompt submission aborted by hook');
      }

      if (typeof output.modifiedInput === 'string') {
        nextPrompt = output.modifiedInput;
      } else if (typeof output.modifiedInput?.userPrompt === 'string') {
        nextPrompt = output.modifiedInput.userPrompt;
      }
    } catch (error) {
      if (spanId) {
        options.traceCollector?.recordHookError?.(spanId, error);
      }
      throw error;
    }
  }

  if (nextPrompt === userMessage.content) {
    return options.request;
  }

  return {
    ...options.request,
    messages: options.request.messages.map((message, index) =>
      index === userMessageIndex ? { ...message, content: nextPrompt } : message
    ),
  };
}

function findLastUserMessageIndex(request: ModelRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === 'user') {
      return index;
    }
  }

  return -1;
}

export async function* streamWithPackageLocalRuntimeTraceCollector<TChunk>(
  options: PackageLocalRuntimeTraceCollectorStreamOptions<TChunk>,
): AsyncGenerator<TChunk> {
  options.hookRuntime.setTraceCollector?.(options.traceCollector);
  try {
    yield* options.stream;
  } finally {
    options.hookRuntime.setTraceCollector?.(undefined);
  }
}
