import { type ChildProcess, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalProcessTree, terminateProcessTree } from '../processTree.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: vi.fn(original.spawnSync),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminateProcessTree', () => {
  it('bounds the Windows taskkill fallback', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);

    expect(signalProcessTree(42_424, 'SIGTERM')).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '42424', '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      },
    );
  });

  it('rejects after bounded force-kill attempts when the tree stays alive', async () => {
    const permissionError = Object.assign(new Error('operation not permitted'), {
      code: 'EPERM',
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw permissionError;
    });
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => false),
    } as unknown as ChildProcess;

    await expect(
      terminateProcessTree(42_424, child, 1),
    ).rejects.toThrow(
      'Failed to terminate process tree 42424 after 3 force-kill attempts',
    );
    expect(child.kill).toHaveBeenCalledTimes(4);
  });
});
