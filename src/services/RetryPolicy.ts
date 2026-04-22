/**
 * RetryPolicy — Production-grade retry strategy
 *
 * Inspired by package 3's withRetry.ts:
 * 1. AsyncGenerator pattern — yields RetryEvent for caller visibility
 * 2. QuerySource foreground/background — background bails on 529 to avoid cascade amplification
 * 3. 529 overload handling — consecutive 529 count triggers model fallback
 * 4. Context overflow auto-adjust — parses "input + max_tokens > limit" errors
 * 5. Stale connection detection — ECONNRESET / EPIPE
 * 6. Exponential backoff + jitter + Retry-After header
 */

// ===== Query Source =====

/**
 * Query source — determines retry strategy for 529 errors.
 * Foreground sources (user is waiting) retry on 529.
 * Background sources (summary, suggestion, etc.) bail immediately to avoid cascade amplification.
 */
export type QuerySource =
  | 'main_thread'
  | 'agent'
  | 'compact'
  | 'side_question'
  | 'hook_agent'
  | 'hook_prompt'
  | 'verification_agent'
  | 'summary'
  | 'suggestion'
  | 'classifier';

const FOREGROUND_RETRY_SOURCES = new Set<QuerySource>([
  'main_thread',
  'agent',
  'compact',
  'side_question',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
]);

function shouldRetry529(querySource?: QuerySource): boolean {
  // undefined → conservative, allow retry
  return querySource === undefined || FOREGROUND_RETRY_SOURCES.has(querySource);
}

// ===== Retry Event =====

export interface RetryEvent {
  type: 'retry_attempt';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: {
    status?: number;
    message: string;
  };
  querySource?: QuerySource;
}

// ===== Retry Config =====

export interface RetryConfig {
  /**
   * Maximum number of retries AFTER the initial attempt.
   * Total attempts = 1 (initial) + maxRetries.
   * e.g. maxRetries: 3 → up to 4 total attempts.
   */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
  /** Consecutive 529 error limit before triggering FallbackTriggeredError */
  max529Retries: number;
  /** Model to fallback to when 529 limit is exceeded */
  fallbackModel?: string;
  /** Current model name (used in FallbackTriggeredError.originalModel) */
  currentModel?: string;
  /** Query source — affects 529 retry strategy */
  querySource?: QuerySource;
  /** Retry callback */
  onRetry?: (event: RetryEvent) => void | Promise<void>;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504],
  max529Retries: 3,
};

// ===== Error Classes =====

import { SdkError } from '../errors/SdkError.js';

/**
 * Non-retryable error — wraps the original error with retry context.
 * Callers can inspect `retryContext.maxTokensOverride` for context overflow recovery.
 */
export class CannotRetryError extends SdkError {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: { model?: string; maxTokensOverride?: number },
  ) {
    const msg = originalError instanceof Error ? originalError.message : String(originalError);
    super('CANNOT_RETRY', msg, { cause: originalError });
    if (originalError instanceof Error && originalError.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      retryContext: this.retryContext,
    };
  }
}

/**
 * Model fallback triggered — consecutive 529 errors exceeded limit.
 */
export class FallbackTriggeredError extends SdkError {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super('FALLBACK_TRIGGERED', `Model fallback triggered: ${originalModel} -> ${fallbackModel}`);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      originalModel: this.originalModel,
      fallbackModel: this.fallbackModel,
    };
  }
}

// ===== Context Overflow =====

export interface ContextOverflowData {
  inputTokens: number;
  maxTokens: number;
  contextLimit: number;
}

const FLOOR_OUTPUT_TOKENS = 3000;

/**
 * Parse "input length and max_tokens exceed context limit: X + Y > Z" errors.
 */
export function parseContextOverflowError(error: unknown): ContextOverflowData | undefined {
  const message = getErrorMessage(error);
  if (!message.includes('input length') || !message.includes('exceed context limit')) {
    return undefined;
  }

  const regex = /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/;
  const match = message.match(regex);
  if (!match || match.length !== 4 || !match[1] || !match[2] || !match[3]) {
    return undefined;
  }

  const inputTokens = parseInt(match[1], 10);
  const maxTokens = parseInt(match[2], 10);
  const contextLimit = parseInt(match[3], 10);

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined;
  }

  return { inputTokens, maxTokens, contextLimit };
}

// ===== Utility Functions =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function getErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }
  if (isRecord(error) && typeof error.name === 'string') {
    return error.name;
  }
  return undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const directStatus = toNumber(error.status) ?? toNumber(error.statusCode);
  if (directStatus !== undefined) {
    return directStatus;
  }

  if (!isRecord(error.response)) {
    return undefined;
  }

  return toNumber(error.response.status) ?? toNumber(error.response.statusCode);
}

function extractHeaderValue(headers: unknown, headerName: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (isRecord(headers) && 'get' in headers && typeof headers.get === 'function') {
    const value = headers.get(headerName);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (!isRecord(headers)) {
    return undefined;
  }

  const headerKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === headerName.toLowerCase(),
  );

  if (!headerKey) {
    return undefined;
  }

  const value = headers[headerKey];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0].trim();
  }

  return undefined;
}

// ===== Abort Handling =====

function isAbortError(error: unknown): boolean {
  return getErrorName(error) === 'AbortError';
}

function getAbortReason(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? getAbortReason(signal) : new Error('The operation was aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ===== Error Classification =====

/**
 * Extract x-should-retry header from error object.
 * This is a non-standard header that the API server uses to explicitly
 * indicate whether the client should retry.
 */
function extractShouldRetryHeader(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;

  // Try error.headers directly (Anthropic SDK pattern)
  const fromDirect = extractHeaderValue(error.headers, 'x-should-retry');
  if (fromDirect) return fromDirect.toLowerCase();

  // Try error.response.headers
  if (isRecord(error.response)) {
    const fromResponse = extractHeaderValue(
      (error.response as Record<string, unknown>).headers,
      'x-should-retry',
    );
    if (fromResponse) return fromResponse.toLowerCase();
  }

  return undefined;
}

/**
 * Check for 529 overloaded error.
 * The SDK sometimes fails to pass the 529 status code during streaming,
 * so we also check the error message body.
 */
export function is529Error(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode === 529) {
    return true;
  }
  const message = getErrorMessage(error);
  return message.includes('"type":"overloaded_error"');
}

/**
 * Check for stale connection errors (ECONNRESET / EPIPE).
 */
export function isStaleConnectionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('econnreset') || message.includes('epipe');
}

function isRetryableErrorForConfig(error: unknown, retryableStatusCodes: number[]): boolean {
  if (isAbortError(error)) {
    return false;
  }

  // Respect x-should-retry server directive if present
  const shouldRetryHeader = extractShouldRetryHeader(error);
  if (shouldRetryHeader === 'true') {
    return true;
  }
  if (shouldRetryHeader === 'false') {
    // For 5xx errors, ignore x-should-retry:false (server bug)
    const statusCode = extractStatusCode(error);
    if (statusCode === undefined || statusCode < 500) {
      return false;
    }
  }

  // Status-code-based classification takes priority over message-based
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    if ([400, 401, 403, 404].includes(statusCode)) {
      return false;
    }

    // 529 handled by dedicated logic
    if (statusCode === 529) {
      return true;
    }

    if (retryableStatusCodes.includes(statusCode)) {
      return true;
    }
  }

  // Message-based classification (only when no status code matched above)
  const message = getErrorMessage(error).toLowerCase();

  // Only match full phrases for permanent errors to avoid false positives
  // (e.g. "port 4003" should not match "400")
  const permanentPatterns = ['bad request', 'unauthorized', 'forbidden', 'not found'];

  if (permanentPatterns.some((pattern) => message.includes(pattern))) {
    return false;
  }

  const transientPatterns = [
    'econnreset',
    'etimedout',
    'socket hang up',
    'fetch failed',
    'network',
    'timeout',
    'rate limit',
    'too many requests',
    'service unavailable',
    'epipe',
  ];

  if (transientPatterns.some((pattern) => message.includes(pattern))) {
    return true;
  }

  // Unknown errors without a status code: not retryable by default to avoid masking bugs.
  // Errors WITH a known status code that didn't match above fall through here too.
  return false;
}

export function isRetryableError(error: unknown): boolean {
  return isRetryableErrorForConfig(error, DEFAULT_RETRY_CONFIG.retryableStatusCodes);
}

// ===== Retry-After Extraction =====

/**
 * Extract Retry-After header from error, checking both error.response.headers
 * and error.headers (some SDKs put headers directly on the error object).
 */
function extractRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  // Try error.response.headers first
  if (isRecord(error.response)) {
    const fromResponse = extractHeaderValue(
      (error.response as Record<string, unknown>).headers,
      'retry-after',
    );
    if (fromResponse) {
      const parsed = parseRetryAfterValue(fromResponse);
      if (parsed !== undefined) return parsed;
    }
  }

  // Try error.headers directly
  const fromError = extractHeaderValue(error.headers, 'retry-after');
  if (fromError) {
    return parseRetryAfterValue(fromError);
  }

  return undefined;
}

function parseRetryAfterValue(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

// ===== Delay Calculation =====

export function getRetryDelay(attempt: number, config: RetryConfig, error?: unknown): number {
  const exponentialDelay = Math.min(
    config.initialDelayMs * config.backoffMultiplier ** Math.max(0, attempt - 1),
    config.maxDelayMs,
  );
  const jitteredDelay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
  const retryAfterDelay = error ? extractRetryAfterMs(error) : undefined;

  return retryAfterDelay !== undefined ? Math.max(jitteredDelay, retryAfterDelay) : jitteredDelay;
}

// ===== Core: withRetry AsyncGenerator =====

/**
 * Mutable retry context — passed to `fn` on each attempt.
 * `withRetry` may mutate `maxTokensOverride` on context overflow errors.
 */
export interface RetryContext {
  /** Adjusted max output tokens (set on context overflow) */
  maxTokensOverride?: number;
}

/**
 * Retry executor — AsyncGenerator version.
 *
 * yield: RetryEvent (emitted before each retry, caller can display to user)
 * return: T (success result)
 * throw: CannotRetryError | FallbackTriggeredError | AbortError
 *
 * Semantics: maxRetries means retries AFTER the initial attempt.
 * Total attempts = 1 (initial) + maxRetries.
 *
 * @param fn Operation to execute. Receives a RetryContext that may contain
 *           maxTokensOverride after a context overflow error.
 */
export async function* withRetry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  partialConfig: Partial<RetryConfig> = {},
  signal?: AbortSignal,
): AsyncGenerator<RetryEvent, T> {
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...partialConfig,
    retryableStatusCodes:
      partialConfig.retryableStatusCodes ?? DEFAULT_RETRY_CONFIG.retryableStatusCodes,
  };
  // maxRetries=3 means 1 initial + 3 retries = 4 total attempts
  const totalAttempts = 1 + Math.max(0, config.maxRetries);
  let consecutive529Errors = 0;
  const retryContext: RetryContext = {};

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    throwIfAborted(signal);

    try {
      return await fn(retryContext);
    } catch (error) {
      if (signal?.aborted) {
        throw getAbortReason(signal);
      }

      // --- 529 overload: background sources bail immediately ---
      if (is529Error(error) && !shouldRetry529(config.querySource)) {
        throw new CannotRetryError(error, {});
      }

      // --- 529 consecutive count → fallback ---
      if (is529Error(error)) {
        consecutive529Errors++;
        if (consecutive529Errors >= config.max529Retries) {
          if (config.fallbackModel) {
            throw new FallbackTriggeredError(
              config.currentModel ?? 'unknown',
              config.fallbackModel,
            );
          }
          throw new CannotRetryError(error, {});
        }
      } else {
        consecutive529Errors = 0;
      }

      // --- Context overflow: adjust maxTokensOverride and retry ---
      const overflowData = parseContextOverflowError(error);
      if (overflowData) {
        const safetyBuffer = 1000;
        const availableContext = Math.max(
          0,
          overflowData.contextLimit - overflowData.inputTokens - safetyBuffer,
        );
        const adjustedMaxTokens = Math.max(FLOOR_OUTPUT_TOKENS, availableContext);

        if (availableContext < FLOOR_OUTPUT_TOKENS) {
          // Not enough room even with minimum tokens — can't recover
          throw new CannotRetryError(error, { maxTokensOverride: FLOOR_OUTPUT_TOKENS });
        }

        // Set override on context so fn() can use it on next attempt
        retryContext.maxTokensOverride = adjustedMaxTokens;
        // Continue to retry (no delay needed — this is a parameter adjustment, not a transient error)
        continue;
      }

      // --- Standard retry check ---
      const retryable = isRetryableErrorForConfig(error, config.retryableStatusCodes);
      if (!retryable || attempt >= totalAttempts) {
        throw new CannotRetryError(error, {});
      }

      const delayMs = getRetryDelay(attempt, config, error);

      const retryEvent: RetryEvent = {
        type: 'retry_attempt',
        attempt,
        maxRetries: config.maxRetries,
        delayMs,
        error: {
          status: extractStatusCode(error),
          message: getErrorMessage(error),
        },
        querySource: config.querySource,
      };

      yield retryEvent;

      if (config.onRetry) {
        await config.onRetry(retryEvent);
      }

      await sleep(delayMs, signal);
    }
  }

  // Unreachable: the for-loop either returns (success) or throws (on last attempt)
  throw new Error('Retry policy exhausted without a result');
}
