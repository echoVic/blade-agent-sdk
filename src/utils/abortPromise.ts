export function getAbortSignalReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function awaitWithAbortSignal<T>(
  operation: () => PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(getAbortSignalReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
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

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(resolveOnce, rejectOnce);
  });
}
