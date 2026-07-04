import { describe, expect, it, vi } from 'vitest';
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  parseContextOverflowError,
  withRetry,
} from '../RetryPolicy.js';

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

describe('@blade-ai/ai retry policy', () => {
  it('retries transient model errors and yields retry events', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
      .mockResolvedValueOnce('ok');

    const { yields, result } = await consumeGenerator(
      withRetry(operation, {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
      }),
    );

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(yields).toEqual([
      expect.objectContaining({
        type: 'retry_attempt',
        attempt: 1,
        error: { status: 503, message: 'Service unavailable' },
      }),
    ]);
  });

  it('keeps retry errors package-local and serializable', async () => {
    const innerError = Object.assign(new Error('Unauthorized'), { status: 401 });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(innerError);

    await expect(consumeGenerator(withRetry(operation, { maxRetries: 3 }))).rejects.toMatchObject({
      code: 'CANNOT_RETRY',
      originalError: innerError,
    });

    try {
      await consumeGenerator(withRetry(operation, { maxRetries: 3 }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CannotRetryError);
      expect((error as CannotRetryError).toJSON()).toMatchObject({
        name: 'CannotRetryError',
        code: 'CANNOT_RETRY',
        retryContext: {},
      });
    }
  });

  it('detects 529 overloads and triggers model fallback', async () => {
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(overloaded);

    expect(is529Error(overloaded)).toBe(true);
    await expect(
      consumeGenerator(
        withRetry(operation, {
          maxRetries: 10,
          initialDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
          max529Retries: 2,
          currentModel: 'primary-model',
          fallbackModel: 'fallback-model',
          querySource: 'main_thread',
        }),
      ),
    ).rejects.toBeInstanceOf(FallbackTriggeredError);
  });

  it('parses context overflow errors for max output token recovery', () => {
    expect(
      parseContextOverflowError(
        new Error('input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000'),
      ),
    ).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    });
  });
});
