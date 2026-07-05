import type { TokenUsage } from '../types/common.js';
import type { SessionId, StreamMessage, UserMessageContent } from './types.js';
import type { SessionTraceFinalizer } from './traces.js';
import {
  reportSessionTaskCompleted,
  type TaskCompletedHookRuntime,
} from './taskCompleted.js';

export type SessionStreamLoopErrorType =
  | 'canceled'
  | 'max_turns_exceeded'
  | 'api_error'
  | 'loop_detected'
  | 'aborted'
  | 'chat_disabled'
  | 'budget_exhausted';

export interface SessionStreamLoopResult {
  success: boolean;
  finalMessage?: string;
  error?: {
    type: SessionStreamLoopErrorType;
    message: string;
    details?: unknown;
  };
  metadata?: {
    turnsCount?: number;
    toolCallsCount?: number;
    duration?: number;
    shouldExitLoop?: boolean;
  };
}

export interface CompleteSessionStreamResultOptions {
  sessionId: SessionId;
  message: UserMessageContent;
  loopResult: SessionStreamLoopResult | undefined;
  usage: TokenUsage;
  hookRuntime: TaskCompletedHookRuntime;
  traceFinalizer: SessionTraceFinalizer;
}

export async function completeSessionStreamResult(
  options: CompleteSessionStreamResultOptions,
): Promise<StreamMessage[]> {
  const { loopResult } = options;
  if (!loopResult) {
    throw new Error('Stream ended without result');
  }

  const isAborted = loopResult.error?.type === 'aborted';
  const shouldExit = loopResult.metadata?.shouldExitLoop;

  if (!loopResult.success && !isAborted && !shouldExit) {
    const message = loopResult.error?.message || 'Unknown error';
    await options.traceFinalizer.finish('error', { error: message });
    return [{ type: 'error', message, sessionId: options.sessionId }];
  }

  const content = loopResult.finalMessage || '';
  await reportSessionTaskCompleted({
    hookRuntime: options.hookRuntime,
    sessionId: options.sessionId,
    message: options.message,
    resultSummary: content,
    success: loopResult.success,
  });
  await options.traceFinalizer.finish(isAborted ? 'aborted' : 'success', {
    content,
    usage: options.usage,
    turnsCount: loopResult.metadata?.turnsCount,
    toolCallsCount: loopResult.metadata?.toolCallsCount,
    duration: loopResult.metadata?.duration,
  });

  return [
    { type: 'usage', usage: options.usage, sessionId: options.sessionId },
    {
      type: 'result',
      subtype: 'success',
      content,
      sessionId: options.sessionId,
    },
  ];
}
