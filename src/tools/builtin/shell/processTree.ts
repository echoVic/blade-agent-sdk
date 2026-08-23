import { type ChildProcess, spawnSync } from 'node:child_process';

const PROCESS_TREE_POLL_INTERVAL_MS = 20;

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
): boolean {
  if (!pid) {
    return child?.kill(signal) ?? false;
  }

  if (process.platform === 'win32') {
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
    if (!isMissingProcess(error)) {
      throw error;
    }
    return child?.kill(signal) ?? false;
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
