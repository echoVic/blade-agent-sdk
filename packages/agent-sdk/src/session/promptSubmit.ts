import type { HookTraceCollector } from '../observability/types.js';
import type { SessionId, StreamMessage, UserMessageContent } from './types.js';
import type { SessionTraceFinalizer } from './traces.js';

export interface PromptSubmitHookRuntime {
  setTraceCollector(traceCollector: HookTraceCollector | undefined): void;
  applyUserPromptSubmit(
    message: UserMessageContent,
    options: { abortSignal: AbortSignal },
  ): Promise<UserMessageContent>;
}

export interface ApplySessionPromptSubmitOptions {
  sessionId: SessionId;
  message: UserMessageContent;
  abortSignal: AbortSignal;
  traceCollector: HookTraceCollector | undefined;
  hookRuntime: PromptSubmitHookRuntime;
  traceFinalizer: SessionTraceFinalizer;
}

export type ApplySessionPromptSubmitResult =
  | { ok: true; message: UserMessageContent }
  | { ok: false; messages: StreamMessage[] };

export async function applySessionPromptSubmit(
  options: ApplySessionPromptSubmitOptions,
): Promise<ApplySessionPromptSubmitResult> {
  options.hookRuntime.setTraceCollector(options.traceCollector);

  try {
    const message = await options.hookRuntime.applyUserPromptSubmit(options.message, {
      abortSignal: options.abortSignal,
    });
    return { ok: true, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.traceFinalizer.finish('error', { error: message });
    options.hookRuntime.setTraceCollector(undefined);
    return {
      ok: false,
      messages: [{ type: 'error', message, sessionId: options.sessionId }],
    };
  }
}
