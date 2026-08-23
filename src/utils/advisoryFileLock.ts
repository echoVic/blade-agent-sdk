import { Mutex, withTimeout } from 'async-mutex';
import { type FileHandle, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const LOCK_RETRY_DELAY_MS = 25;

interface FileMutexEntry {
  mutex: Mutex;
  users: number;
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
  errors: AdvisoryFileLockErrors;
}

async function runWithFileMutex<T>(
  filePath: string,
  timeoutMs: number,
  timeoutError: Error,
  callback: () => Promise<T>,
): Promise<T> {
  let entry = FILE_MUTEXES.get(filePath);
  if (!entry) {
    entry = { mutex: new Mutex(), users: 0 };
    FILE_MUTEXES.set(filePath, entry);
  }
  entry.users += 1;
  try {
    return await withTimeout(entry.mutex, timeoutMs, timeoutError).runExclusive(callback);
  } finally {
    entry.users -= 1;
    if (entry.users === 0) {
      FILE_MUTEXES.delete(filePath);
    }
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
): Promise<() => Promise<void>> {
  let nativeFileLock: NativeFileLock;
  let lockFile: FileHandle;
  try {
    nativeFileLock = await loadNativeFileLock();
    lockFile = await open(`${filePath}.lock`, 'a+', 0o600);
  } catch (error) {
    throw errors.initialize(error);
  }

  try {
    let attempted = false;
    while (true) {
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
        return async () => {
          if (released) {
            return;
          }
          released = true;
          await releaseProcessLock(lockFile, nativeFileLock.unlock);
        };
      }

      const retryWaitMs = deadline - performance.now();
      if (retryWaitMs <= 0) {
        throw errors.timeout();
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, Math.min(LOCK_RETRY_DELAY_MS, retryWaitMs));
      });
    }
  } catch (error) {
    try {
      await lockFile.close();
    } catch {
      // Preserve the acquisition error; no lock was acquired.
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
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(dirname(filePath));
    lockTarget = join(canonicalDirectory, basename(filePath));
  } catch (error) {
    throw options.errors.prepare(error);
  }

  const localWaitMs = Math.max(0, deadline - performance.now());
  return runWithFileMutex(
    lockTarget,
    localWaitMs,
    options.errors.timeout(),
    async () => {
      const release = await acquireProcessLock(
        lockTarget,
        options.timeoutMs,
        deadline,
        options.errors,
      );

      let result: T;
      try {
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
