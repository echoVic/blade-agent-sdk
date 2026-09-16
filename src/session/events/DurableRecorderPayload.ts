import type { ModelRequestLifecycle } from '../../agent/ModelExecutionLifecycle.js';
import type { LoopResult } from '../../agent/types.js';
import type { TokenUsage } from '../../model/usage.js';
import { type InputId, ToolUseId } from '../../types/identifiers.js';
import type { JsonValue } from '../../types/json.js';
import type {
  DurableEventError,
  DurableModelResponse,
  DurableRequestInterruptReason,
} from './types.js';

export type DurableRequestFinish =
  | { status: 'completed'; output?: JsonValue; usage?: TokenUsage }
  | { status: 'failed'; error: unknown }
  | {
      status: 'interrupted';
      reason: DurableRequestInterruptReason;
      byInputId?: InputId;
    };

export function toDurableEventError(error: unknown, fallbackMessage: string): DurableEventError {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error);
  return {
    message: message.trim() || fallbackMessage,
    ...(typeof record?.code === 'string' && record.code.trim() ? { code: record.code } : {}),
    ...(typeof record?.retryable === 'boolean' ? { retryable: record.retryable } : {}),
  };
}

export function toDurableModelResponse(
  response: Parameters<ModelRequestLifecycle['onCompleted']>[0],
): DurableModelResponse {
  const usage = response.usage;
  return {
    content: response.content,
    ...(response.reasoningContent !== undefined
      ? { reasoningContent: response.reasoningContent }
      : {}),
    ...(response.toolCalls?.length
      ? {
          toolCalls: response.toolCalls.map((toolCall) => ({
            id: ToolUseId(toolCall.id),
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          })),
        }
      : {}),
    ...(usage
      ? {
          usage: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            ...(usage.reasoningTokens !== undefined
              ? { reasoningTokens: usage.reasoningTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
              : {}),
            ...(usage.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: usage.cacheReadInputTokens }
              : {}),
            ...(usage.cacheMissInputTokens !== undefined
              ? { cacheMissInputTokens: usage.cacheMissInputTokens }
              : {}),
            ...(usage.billableInputTokens !== undefined
              ? { billableInputTokens: usage.billableInputTokens }
              : {}),
          },
        }
      : {}),
  };
}

export function durableRequestFinishFromLoopResult(
  result: LoopResult,
  usage: TokenUsage,
  interruptionReason: DurableRequestInterruptReason = 'user_abort',
): DurableRequestFinish {
  if (result.error?.type === 'aborted') {
    return { status: 'interrupted', reason: interruptionReason };
  }
  if (!result.success && !result.metadata?.shouldExitLoop) {
    return { status: 'failed', error: result.error?.message ?? 'Agent request failed' };
  }
  return { status: 'completed', output: result.finalMessage ?? '', usage };
}
