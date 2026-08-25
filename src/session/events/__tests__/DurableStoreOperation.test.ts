import { describe, expect, it, vi } from 'vitest';
import { awaitDurableStoreOperation } from '../DurableStoreOperation.js';

describe('awaitDurableStoreOperation', () => {
  it('does not start a Store callback after cancellation settles the operation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before Store start');
    const operation = vi.fn(async () => 'unexpected');
    const result = awaitDurableStoreOperation(
      {
        timeoutMs: 1_000,
        signal: controller.signal,
        createTimeoutError: () => new Error('timeout'),
      },
      operation,
    );

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });

  it('observes a Store rejection that arrives after the host deadline', async () => {
    vi.useFakeTimers();
    const release = Promise.withResolvers<void>();
    const lateError = new Error('late Store failure');
    const result = awaitDurableStoreOperation(
      {
        timeoutMs: 25,
        createTimeoutError: () => new Error('deadline exceeded'),
      },
      async () => {
        await release.promise;
        throw lateError;
      },
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const rejection = expect(result).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      release.resolve();
      await vi.runAllTimersAsync();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });
});
