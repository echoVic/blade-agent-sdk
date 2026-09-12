import type { InternalLogger } from '../../../logging/Logger.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';

export function createExecutionFailureResult(
  message: string,
  type: ToolErrorType = ToolErrorType.EXECUTION_ERROR,
): ToolResult {
  return {
    status: 'error',
    model: `Tool execution failed: ${message}`,
    error: {
      type,
      message,
    },
  };
}

export function createHookFailureResult(message: string): ToolResult {
  return createExecutionFailureResult(message);
}

export function createAbortedResult(
  reason?: string,
  options?: {
    shouldExitLoop?: boolean;
    errorType?: ToolErrorType;
  },
): ToolResult {
  return {
    status: 'error',
    model: `Tool execution aborted: ${reason || 'Unknown reason'}`,
    error: {
      type: options?.errorType ?? ToolErrorType.EXECUTION_ERROR,
      message: reason || 'Execution aborted',
    },
    metadata: options?.shouldExitLoop ? { shouldExitLoop: true } : undefined,
  };
}

/**
 * Refuse to start another tool while an earlier callback or tool execution is
 * still cleaning up: ownership of that work is no longer provable.
 */
export function createPendingCleanupResult(source: 'permission callback' | 'tool execution'): ToolResult {
  const label = source === 'permission callback' ? 'A permission callback' : 'A tool execution';
  return createExecutionFailureResult(
    `${label} is still cleaning up; refusing to start another tool`,
  );
}

/**
 * A timeout is a hard deadline: hooks or middleware may annotate the failure but
 * must not downgrade it back to success.
 */
export function preserveTimeoutFailure(
  logger: InternalLogger,
  original: ToolResult,
  transformed: ToolResult,
  source: string,
): ToolResult {
  if (
    original.status !== 'error' ||
    original.error.type !== ToolErrorType.TIMEOUT_ERROR ||
    (transformed.status === 'error' && transformed.error.type === ToolErrorType.TIMEOUT_ERROR)
  ) {
    return transformed;
  }

  logger.warn(`${source} attempted to replace a tool timeout; preserving timeout semantics`);
  if (transformed.status === 'success') {
    return original;
  }
  return {
    ...transformed,
    error: {
      ...transformed.error,
      type: ToolErrorType.TIMEOUT_ERROR,
    },
  };
}

export function truncateStringResult(
  value: unknown,
  maxLength: number,
): { value: string; originalLength: number } | undefined {
  if (typeof value !== 'string' || value.length <= maxLength) {
    return undefined;
  }

  const removedChars = value.length - maxLength;
  const suffix = `\n\n...[truncated ${removedChars} chars]`;
  if (maxLength <= suffix.length) {
    return {
      value: value.slice(0, maxLength),
      originalLength: value.length,
    };
  }

  return {
    value: `${value.slice(0, maxLength - suffix.length)}${suffix}`,
    originalLength: value.length,
  };
}
