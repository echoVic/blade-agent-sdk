import { CannotRetryError, parseContextOverflowError } from '../../services/RetryPolicy.js';

const CONTEXT_OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'too many tokens',
  'request too large',
  'context window',
];

function hasLegacyOverflowMessage(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => message.includes(pattern))
    || (message.includes('413') && message.includes('payload'));
}

function getErrorCause(error: unknown): unknown {
  if (!(error instanceof Error) || !('cause' in error)) {
    return undefined;
  }

  return (error as Error & { cause?: unknown }).cause;
}

export function isOverflowRecoverable(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (parseContextOverflowError(current) || hasLegacyOverflowMessage(current)) {
      return true;
    }

    if (current instanceof CannotRetryError) {
      queue.push(current.originalError);
    }

    const cause = getErrorCause(current);
    if (cause !== undefined) {
      queue.push(cause);
    }
  }

  return false;
}
