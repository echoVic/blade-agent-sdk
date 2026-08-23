import { type ChildProcess, spawnSync } from 'node:child_process';

const PROCESS_TREE_POLL_INTERVAL_MS = 20;
const PROCESS_TREE_FORCE_KILL_ATTEMPTS = 3;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ESRCH'
  );
}

export function shellProcessSpawnOptions(): {
  detached: boolean;
  windowsHide: boolean;
} {
  return {
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
}

export function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  child?: ChildProcess,
  taskkillTimeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS,
): boolean {
  if (!pid) {
    return child?.kill(signal) ?? false;
  }

  if (process.platform === 'win32') {
    // Windows has no POSIX signal semantics for console process trees.
    // taskkill /T /F therefore force-terminates the complete tree.
    const result = spawnSync(
      'taskkill',
      [
        '/pid',
        String(pid),
        '/t',
        '/f',
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: taskkillTimeoutMs,
      },
    );
    if (result.status === 0) {
      return true;
    }
    return child?.kill(signal) ?? false;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    try {
      return child?.kill(signal) ?? false;
    } catch {
      if (!isMissingProcess(error)) {
        throw error;
      }
      return false;
    }
  }
}

export function isProcessTreeAlive(
  pid: number | undefined,
  child?: ChildProcess,
): boolean {
  if (!pid) {
    return child?.exitCode === null && child.signalCode === null;
  }

  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
}

export async function waitForProcessTreeExit(
  pid: number | undefined,
  child: ChildProcess | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(pid, child)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs),
      );
    });
  }
  return true;
}

/** Escalates process-tree termination and rejects if the tree remains alive. */
export async function terminateProcessTree(
  pid: number | undefined,
  child: ChildProcess | undefined,
  gracePeriodMs: number,
): Promise<void> {
  let lastSignalError: unknown;
  const signalSafely = (signal: NodeJS.Signals): void => {
    try {
      if (!signalProcessTree(pid, signal, child, gracePeriodMs)) {
        lastSignalError = new Error(
          `Process tree ${pid ?? 'unknown'} did not accept ${signal}`,
        );
      }
    } catch (error) {
      lastSignalError = error;
    }
  };

  if (!pid) {
    signalSafely('SIGTERM');
    return;
  }

  signalSafely('SIGTERM');
  if (await waitForProcessTreeExit(pid, child, gracePeriodMs)) {
    return;
  }

  for (
    let attempt = 0;
    attempt < PROCESS_TREE_FORCE_KILL_ATTEMPTS;
    attempt += 1
  ) {
    signalSafely('SIGKILL');
    if (await waitForProcessTreeExit(pid, child, gracePeriodMs)) {
      return;
    }
  }

  throw new Error(
    `Failed to terminate process tree ${pid} after ${PROCESS_TREE_FORCE_KILL_ATTEMPTS} force-kill attempts`,
    { cause: lastSignalError },
  );
}
