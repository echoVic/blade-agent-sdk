import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CannotRetryError,
  DEFAULT_RETRY_CONFIG,
  FallbackTriggeredError,
  getRetryDelay,
  is529Error,
  isRetryableError,
  isStaleConnectionError,
  parseContextOverflowError,
  withRetry,
  type RetryEvent,
} from '../RetryPolicy.js';
import { assertDefined } from '../../__tests__/helpers/assertDefined.js';

/**
 * Helper: consume an AsyncGenerator, collecting yields and returning the result.
 */
async function consumeGenerator<Y, R>(
  gen: AsyncGenerator<Y, R>,
): Promise<{ yields: Y[]; result: R }> {
  const yields: Y[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { yields, result: value };
    yields.push(value);
  }
}

/** Minimal retry config with zero delays for fast tests */
const FAST_CONFIG = {
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
} as const;

describe('RetryPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== isRetryableError =====

  describe('isRetryableError', () => {
    it('returns true for retryable status codes', () => {
      expect(
        isRetryableError(Object.assign(new Error('Too many requests'), { status: 429 })),
      ).toBe(true);
      expect(
        isRetryableError(Object.assign(new Error('Server error'), { statusCode: 500 })),
      ).toBe(true);
      expect(
        isRetryableError(Object.assign(new Error('Service unavailable'), { status: 503 })),
      ).toBe(true);
    });

    it('returns false for permanent client errors', () => {
      expect(
        isRetryableError(Object.assign(new Error('Unauthorized'), { status: 401 })),
      ).toBe(false);
      expect(
        isRetryableError(Object.assign(new Error('Forbidden'), { status: 403 })),
      ).toBe(false);
      expect(
        isRetryableError(Object.assign(new Error('Bad request'), { status: 400 })),
      ).toBe(false);
    });

    it('returns true for transient network messages', () => {
      expect(isRetryableError(new Error('read ECONNRESET while contacting upstream'))).toBe(
        true,
      );
    });

    it('returns true for 529 errors', () => {
      expect(
        isRetryableError(Object.assign(new Error('Overloaded'), { status: 529 })),
      ).toBe(true);
    });
  });

  // ===== is529Error =====

  describe('is529Error', () => {
    it('detects 529 status code', () => {
      expect(is529Error(Object.assign(new Error('overloaded'), { status: 529 }))).toBe(true);
    });

    it('detects overloaded_error in message', () => {
      expect(is529Error(new Error('{"type":"overloaded_error"}'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(is529Error(new Error('rate limited'))).toBe(false);
      expect(is529Error(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(false);
    });
  });

  // ===== isStaleConnectionError =====

  describe('isStaleConnectionError', () => {
    it('detects ECONNRESET', () => {
      expect(isStaleConnectionError(new Error('read ECONNRESET'))).toBe(true);
    });

    it('detects EPIPE', () => {
      expect(isStaleConnectionError(new Error('write EPIPE'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isStaleConnectionError(new Error('timeout'))).toBe(false);
    });
  });

  // ===== parseContextOverflowError =====

  describe('parseContextOverflowError', () => {
    it('parses standard overflow message', () => {
      const error = new Error(
        'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
      );
      const result = parseContextOverflowError(error);
      expect(result).toEqual({
        inputTokens: 188059,
        maxTokens: 20000,
        contextLimit: 200000,
      });
    });

    it('returns undefined for non-overflow errors', () => {
      expect(parseContextOverflowError(new Error('rate limited'))).toBeUndefined();
    });

    it('returns undefined for malformed overflow message', () => {
      expect(
        parseContextOverflowError(new Error('input length and `max_tokens` exceed context limit: bad')),
      ).toBeUndefined();
    });
  });

  // ===== getRetryDelay =====

  describe('getRetryDelay', () => {
    it('uses exponential backoff for subsequent attempts', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      expect(getRetryDelay(1, DEFAULT_RETRY_CONFIG)).toBe(1000);
      expect(getRetryDelay(3, DEFAULT_RETRY_CONFIG)).toBe(4000);
    });

    it('caps the delay at the configured maximum', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      expect(
        getRetryDelay(6, {
          ...DEFAULT_RETRY_CONFIG,
          maxDelayMs: 5000,
        }),
      ).toBe(5000);
    });

    it('applies jitter within plus or minus twenty percent', () => {
      const randomSpy = vi.spyOn(Math, 'random');
      randomSpy.mockReturnValueOnce(0);
      randomSpy.mockReturnValueOnce(1);

      const config = {
        ...DEFAULT_RETRY_CONFIG,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
      };

      expect(getRetryDelay(2, config)).toBe(1600);
      expect(getRetryDelay(2, config)).toBe(2400);
    });
  });

  // ===== withRetry (AsyncGenerator) =====

  describe('withRetry', () => {
    it('returns immediately on success without yielding', async () => {
      const operation = vi.fn().mockResolvedValue('ok');

      const { yields, result } = await consumeGenerator(
        withRetry(operation),
      );

      expect(result).toBe('ok');
      expect(yields).toHaveLength(0);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('retries once and yields a RetryEvent', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const onRetry = vi.fn();
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(
          Object.assign(new Error('Service unavailable'), { status: 503 }),
        )
        .mockResolvedValueOnce('ok');

      const { yields, result } = await consumeGenerator(
        withRetry(operation, {
          maxRetries: 3,
          ...FAST_CONFIG,
          onRetry,
        }),
      );

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(yields).toHaveLength(1);

      const event = yields[0];
      assertDefined(event);
      expect(event.type).toBe('retry_attempt');
      expect(event.attempt).toBe(1);
      expect(event.error.status).toBe(503);
      expect(event.error.message).toBe('Service unavailable');

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'retry_attempt', attempt: 1 }),
      );
    });

    it('throws CannotRetryError for permanent errors (no retry)', async () => {
      const innerError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const operation = vi.fn<() => Promise<string>>().mockRejectedValue(innerError);

      try {
        await consumeGenerator(withRetry(operation, { maxRetries: 3 }));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CannotRetryError);
        expect((error as CannotRetryError).originalError).toBe(innerError);
      }

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('stops when abort signal is triggered before first attempt', async () => {
      const controller = new AbortController();
      controller.abort(new Error('pre-aborted'));

      const operation = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

      try {
        await consumeGenerator(
          withRetry(operation, { maxRetries: 3 }, controller.signal),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toBe('pre-aborted');
      }

      expect(operation).not.toHaveBeenCalled();
    });

    it('stops when abort signal is triggered during retry sleep', async () => {
      const controller = new AbortController();
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 }));

      const gen = withRetry(
        operation,
        {
          maxRetries: 3,
          initialDelayMs: 5000, // long enough that abort fires first
          maxDelayMs: 5000,
          backoffMultiplier: 1,
        },
        controller.signal,
      );

      // First next(): attempt 1 fails, yields RetryEvent
      const step1 = await gen.next();
      expect(step1.done).toBe(false);

      // Abort during sleep — next gen.next() should throw
      setTimeout(() => controller.abort(new Error('user canceled')), 10);

      try {
        await gen.next();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toBe('user canceled');
      }
    });

    it('throws CannotRetryError after max retries exhausted', async () => {
      const innerError = Object.assign(new Error('Rate limited'), { status: 429 });
      const operation = vi.fn<() => Promise<string>>().mockRejectedValue(innerError);

      try {
        await consumeGenerator(
          withRetry(operation, {
            maxRetries: 2,
            ...FAST_CONFIG,
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CannotRetryError);
        expect((error as CannotRetryError).originalError).toBe(innerError);
      }

      // maxRetries: 2 → 1 initial + 2 retries = 3 total attempts
      expect(operation).toHaveBeenCalledTimes(3);
    });

    // ===== 529 specific behavior =====

    it('immediately fails background querySource on 529', async () => {
      const error529 = Object.assign(new Error('overloaded'), { status: 529 });
      const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error529);

      try {
        await consumeGenerator(
          withRetry(operation, {
            maxRetries: 3,
            querySource: 'summary', // background source
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CannotRetryError);
      }

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('retries foreground querySource on 529', async () => {
      const error529 = Object.assign(new Error('overloaded'), { status: 529 });
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(error529)
        .mockResolvedValueOnce('ok');

      const { yields, result } = await consumeGenerator(
        withRetry(operation, {
          maxRetries: 3,
          ...FAST_CONFIG,
          querySource: 'main_thread', // foreground source
        }),
      );

      expect(result).toBe('ok');
      expect(yields).toHaveLength(1);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('triggers FallbackTriggeredError after max 529 retries with fallback model', async () => {
      const error529 = Object.assign(new Error('overloaded'), { status: 529 });
      const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error529);

      try {
        await consumeGenerator(
          withRetry(operation, {
            maxRetries: 10,
            ...FAST_CONFIG,
            max529Retries: 2,
            fallbackModel: 'claude-sonnet',
            currentModel: 'claude-opus',
            querySource: 'main_thread',
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FallbackTriggeredError);
        const fe = error as FallbackTriggeredError;
        expect(fe.originalModel).toBe('claude-opus');
        expect(fe.fallbackModel).toBe('claude-sonnet');
      }

      // 2 attempts: first 529 → retry, second 529 → consecutive=2 >= max529Retries → fallback
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('throws CannotRetryError on max 529 retries without fallback model', async () => {
      const error529 = Object.assign(new Error('overloaded'), { status: 529 });
      const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error529);

      try {
        await consumeGenerator(
          withRetry(operation, {
            maxRetries: 10,
            ...FAST_CONFIG,
            max529Retries: 2,
            querySource: 'main_thread',
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CannotRetryError);
      }

      expect(operation).toHaveBeenCalledTimes(2);
    });

    // ===== Context overflow =====

    it('retries with adjusted maxTokensOverride on context overflow', async () => {
      const overflowError = new Error(
        'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
      );
      Object.assign(overflowError, { status: 400 });

      let capturedCtx: { maxTokensOverride?: number } | undefined;
      const operation = vi
        .fn<(ctx: { maxTokensOverride?: number }) => Promise<string>>()
        .mockImplementationOnce(() => { throw overflowError; })
        .mockImplementation((ctx) => {
          capturedCtx = ctx;
          return Promise.resolve('ok');
        });

      const { result } = await consumeGenerator(
        withRetry(operation, { maxRetries: 3, ...FAST_CONFIG }),
      );

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
      // contextLimit(200000) - inputTokens(188059) - safetyBuffer(1000) = 10941
      expect(capturedCtx?.maxTokensOverride).toBe(10941);
    });

    it('throws CannotRetryError when overflow leaves insufficient space', async () => {
      // inputTokens nearly fills context — only 500 tokens left < FLOOR_OUTPUT_TOKENS(3000)
      const overflowError = new Error(
        'input length and `max_tokens` exceed context limit: 199000 + 20000 > 200000',
      );
      Object.assign(overflowError, { status: 400 });
      const operation = vi.fn<(ctx: { maxTokensOverride?: number }) => Promise<string>>()
        .mockRejectedValue(overflowError);

      try {
        await consumeGenerator(withRetry(operation, { maxRetries: 3 }));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CannotRetryError);
      }

      expect(operation).toHaveBeenCalledTimes(1);
    });

    // ===== 529 counter reset on non-529 error =====

    it('resets consecutive 529 counter on non-529 error', async () => {
      const error529 = Object.assign(new Error('overloaded'), { status: 529 });
      const error500 = Object.assign(new Error('server error'), { status: 500 });

      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(error529)      // 529 count: 1
        .mockRejectedValueOnce(error500)       // reset to 0
        .mockRejectedValueOnce(error529)       // 529 count: 1
        .mockResolvedValueOnce('ok');

      const { yields, result } = await consumeGenerator(
        withRetry(operation, {
          maxRetries: 10,
          ...FAST_CONFIG,
          max529Retries: 2,
          querySource: 'main_thread',
        }),
      );

      expect(result).toBe('ok');
      expect(yields).toHaveLength(3); // 3 retry events
      expect(operation).toHaveBeenCalledTimes(4);
    });

    it('yields multiple RetryEvents for multiple retries', async () => {
      const error503 = Object.assign(new Error('unavailable'), { status: 503 });
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(error503)
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce('ok');

      const { yields, result } = await consumeGenerator(
        withRetry(operation, {
          maxRetries: 5,
          ...FAST_CONFIG,
        }),
      );

      expect(result).toBe('ok');
      expect(yields).toHaveLength(2);
      assertDefined(yields[0]);
      assertDefined(yields[1]);
      expect(yields[0].attempt).toBe(1);
      expect(yields[1].attempt).toBe(2);
    });
  });
});
