import { getAbortSignalReason } from '../../utils/abortPromise.js';

export const DEFAULT_DURABLE_STORE_TIMEOUT_MS = 15_000;
export const MAX_DURABLE_STORE_TIMEOUT_MS = 2_147_483_647;

export function resolveDurableStoreTimeoutMs(
  value: number | undefined,
  fallback = DEFAULT_DURABLE_STORE_TIMEOUT_MS,
  name = 'durableStoreTimeoutMs',
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_DURABLE_STORE_TIMEOUT_MS) {
    throw new RangeError(
      `${name} must be a positive integer no greater than ${MAX_DURABLE_STORE_TIMEOUT_MS}`,
    );
  }
  return resolved;
}

export interface DurableStoreDeadlineOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly createTimeoutError: () => Error;
}

/**
 * Applies a host-enforced deadline while forwarding cancellation to a
 * cooperative Store. The Store promise remains observed after the deadline.
 */
export function awaitDurableStoreOperation<T>(
  options: DurableStoreDeadlineOptions,
  operation: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  if (options.signal?.aborted) {
    return Promise.reject(getAbortSignalReason(options.signal));
  }

  const timeoutController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(getAbortSignalReason(signal));
    };
    const timer = setTimeout(() => {
      const error = options.createTimeoutError();
      timeoutController.abort(error);
      rejectOnce(error);
    }, options.timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .then(resolveOnce, rejectOnce);
  });
}
