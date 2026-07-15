export type CleanupFn = () => void | Promise<void>;

export interface CleanupHandle {
  unregister: () => void;
}

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

let cleanupFns: CleanupFn[] = [];
let isShuttingDown = false;

export function registerCleanup(fn: CleanupFn): CleanupHandle {
  cleanupFns.push(fn);
  let removed = false;
  return {
    unregister: () => {
      if (removed) {
        return;
      }
      removed = true;
      const idx = cleanupFns.indexOf(fn);
      if (idx !== -1) {
        cleanupFns.splice(idx, 1);
      }
    },
  };
}

export async function gracefulShutdown(
  options?: GracefulShutdownOptions,
): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  const timeoutMs = options?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onError = options?.onError ?? (() => {});

  const fns = [...cleanupFns];
  cleanupFns = [];

  const runAll = async () => {
    const results = await Promise.allSettled(
      fns.map((fn) => {
        try {
          return Promise.resolve(fn());
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        onError(result.reason);
      }
    }
  };

  if (timeoutMs <= 0) {
    try {
      await runAll();
    } finally {
      isShuttingDown = false;
    }
    return;
  }

  try {
    await Promise.race([
      runAll(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    onError(err);
  } finally {
    isShuttingDown = false;
  }
}

export function resetCleanupRegistry(): void {
  cleanupFns = [];
  isShuttingDown = false;
}
