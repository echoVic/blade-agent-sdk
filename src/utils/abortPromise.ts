export function getAbortSignalReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export interface AbortDeadlineOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly controller?: AbortController;
  readonly createTimeoutError: () => Error;
}

export function awaitWithAbortSignal<T>(
  operation: () => PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(getAbortSignalReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const settle = <TValue>(callback: (value: TValue) => void, value: TValue): void => {
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = (): void => {
      settle(reject, getAbortSignalReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
  });
}

export function awaitWithDeadline<T>(
  options: AbortDeadlineOptions,
  operation: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const controller = options.controller ?? new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(options.createTimeoutError()), options.timeoutMs);
  return awaitWithAbortSignal(() => operation(signal), signal).finally(() => clearTimeout(timer));
}
