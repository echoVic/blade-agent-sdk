import { type FileHandle, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getAbortSignalReason } from './abortPromise.js';

const LOCK_RETRY_DELAY_MS = 25;

interface FileMutexEntry {
  locked: boolean;
  waiters: FileMutexWaiter[];
}

interface FileMutexWaiter {
  grant(): boolean;
}

const FILE_MUTEXES = new Map<string, FileMutexEntry>();

type NativeFileLock = Pick<typeof import('fs-native-extensions'), 'tryLock' | 'unlock'>;

let nativeFileLockPromise: Promise<NativeFileLock> | undefined;

function loadNativeFileLock(): Promise<NativeFileLock> {
  nativeFileLockPromise ??= import('fs-native-extensions').catch((error: unknown) => {
    nativeFileLockPromise = undefined;
    throw error;
  });
  return nativeFileLockPromise;
}

export interface AdvisoryFileLockErrors {
  prepare(cause: unknown): Error;
  initialize(cause: unknown): Error;
  acquire(cause: unknown): Error;
  timeout(): Error;
  release(cause: unknown): Error;
}

export interface AdvisoryFileLockOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  errors: AdvisoryFileLockErrors;
}

function cleanupFileMutex(filePath: string, entry: FileMutexEntry): void {
  if (!entry.locked && entry.waiters.length === 0 && FILE_MUTEXES.get(filePath) === entry) {
    FILE_MUTEXES.delete(filePath);
  }
}

function dispatchFileMutex(filePath: string, entry: FileMutexEntry): void {
  entry.locked = false;
  while (entry.waiters.length > 0) {
    const waiter = entry.waiters.shift();
    if (waiter?.grant()) {
      return;
    }
  }
  cleanupFileMutex(filePath, entry);
}

function acquireFileMutex(
  filePath: string,
  timeoutMs: number,
  timeoutError: Error,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(getAbortSignalReason(signal));
  }
  let entry = FILE_MUTEXES.get(filePath);
  if (!entry) {
    entry = { locked: false, waiters: [] };
    FILE_MUTEXES.set(filePath, entry);
  }

  return new Promise<() => void>((resolve, reject) => {
    let deadline: number | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const cancel = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const index = entry.waiters.indexOf(waiter);
      if (index !== -1) {
        entry.waiters.splice(index, 1);
      }
      cleanupFileMutex(filePath, entry);
      reject(error);
    };
    const onAbort = (): void => cancel(getAbortSignalReason(signal as AbortSignal));
    const waiter: FileMutexWaiter = {
      grant: () => {
        if (settled) {
          return false;
        }
        if (deadline !== undefined && performance.now() >= deadline) {
          cancel(timeoutError);
          return false;
        }
        settled = true;
        cleanup();
        entry.locked = true;
        let released = false;
        resolve(() => {
          if (released) {
            return;
          }
          released = true;
          dispatchFileMutex(filePath, entry);
        });
        return true;
      },
    };

    if (!entry.locked && entry.waiters.length === 0) {
      waiter.grant();
      return;
    }
    if (timeoutMs <= 0) {
      cancel(timeoutError);
      return;
    }
    deadline = performance.now() + timeoutMs;
    entry.waiters.push(waiter);
    timer = setTimeout(() => cancel(timeoutError), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function runWithFileMutex<T>(
  filePath: string,
  timeoutMs: number,
  timeoutError: Error,
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireFileMutex(filePath, timeoutMs, timeoutError, signal);
  try {
    signal?.throwIfAborted();
    return await callback();
  } finally {
    release();
  }
}

async function releaseProcessLock(
  lockFile: FileHandle,
  unlockFile: NativeFileLock['unlock'],
): Promise<void> {
  let releaseError: unknown;
  try {
    unlockFile(lockFile.fd);
  } catch (error) {
    releaseError = error;
  }
  try {
    await lockFile.close();
  } catch (error) {
    releaseError ??= error;
  }
  if (releaseError) {
    throw releaseError;
  }
}

async function acquireProcessLock(
  filePath: string,
  timeoutMs: number,
  deadline: number,
  errors: AdvisoryFileLockErrors,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  let nativeFileLock: NativeFileLock;
  try {
    signal?.throwIfAborted();
    nativeFileLock = await loadNativeFileLock();
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) {
      throw getAbortSignalReason(signal);
    }
    throw errors.initialize(error);
  }

  let lockFile: FileHandle | undefined;
  try {
    lockFile = await open(`${filePath}.lock`, 'a+', 0o600);
    signal?.throwIfAborted();
  } catch (error) {
    try {
      await lockFile?.close();
    } catch {
      // Preserve the initialization or cancellation error.
    }
    if (signal?.aborted) {
      throw getAbortSignalReason(signal);
    }
    throw errors.initialize(error);
  }

  let acquiredRelease: (() => Promise<void>) | undefined;
  try {
    let attempted = false;
    while (true) {
      signal?.throwIfAborted();
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0 && (attempted || timeoutMs > 0)) {
        throw errors.timeout();
      }
      attempted = true;

      let acquired: boolean;
      try {
        acquired = nativeFileLock.tryLock(lockFile.fd);
      } catch (error) {
        throw errors.acquire(error);
      }
      if (acquired) {
        let released = false;
        acquiredRelease = async () => {
          if (released) {
            return;
          }
          released = true;
          await releaseProcessLock(lockFile, nativeFileLock.unlock);
        };
        signal?.throwIfAborted();
        return acquiredRelease;
      }

      const retryWaitMs = deadline - performance.now();
      if (retryWaitMs <= 0) {
        throw errors.timeout();
      }
      await new Promise<void>((resolveDelay, rejectDelay) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          callback();
        };
        const onAbort = (): void =>
          finish(() => rejectDelay(getAbortSignalReason(signal as AbortSignal)));
        const timer = setTimeout(
          () => finish(resolveDelay),
          Math.min(LOCK_RETRY_DELAY_MS, retryWaitMs),
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });
    }
  } catch (error) {
    try {
      if (acquiredRelease) {
        await acquiredRelease();
      } else {
        await lockFile.close();
      }
    } catch {
      // Preserve the acquisition or cancellation error.
    }
    throw error;
  }
}

export async function withAdvisoryFileLock<T>(
  filePath: string,
  options: AdvisoryFileLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + options.timeoutMs;
  let lockTarget: string;
  try {
    options.signal?.throwIfAborted();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    options.signal?.throwIfAborted();
    const canonicalDirectory = await realpath(dirname(filePath));
    options.signal?.throwIfAborted();
    lockTarget = join(canonicalDirectory, basename(filePath));
  } catch (error) {
    if (options.signal?.aborted) {
      throw getAbortSignalReason(options.signal);
    }
    throw options.errors.prepare(error);
  }

  const localWaitMs = Math.max(0, deadline - performance.now());
  return runWithFileMutex(
    lockTarget,
    localWaitMs,
    options.errors.timeout(),
    async () => {
      options.signal?.throwIfAborted();
      const release = await acquireProcessLock(
        lockTarget,
        options.timeoutMs,
        deadline,
        options.errors,
        options.signal,
      );

      let result: T;
      try {
        options.signal?.throwIfAborted();
        result = await callback();
      } catch (error) {
        try {
          await release();
        } catch {
          // Preserve the operation error; its result did not complete successfully.
        }
        throw error;
      }

      try {
        await release();
      } catch (error) {
        throw options.errors.release(error);
      }
      return result;
    },
    options.signal,
  );
}

/** Persist a newly created file's directory entry on filesystems that support it. */
export async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const directory = await open(dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
