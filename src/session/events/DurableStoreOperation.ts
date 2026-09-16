import { type AbortDeadlineOptions, awaitWithDeadline } from '../../utils/abortPromise.js';

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

export type DurableStoreDeadlineOptions = AbortDeadlineOptions;

export function awaitDurableStoreOperation<T>(
  options: DurableStoreDeadlineOptions,
  operation: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  return awaitWithDeadline(options, (signal) => {
    signal.throwIfAborted();
    return operation(signal);
  });
}
