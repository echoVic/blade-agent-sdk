import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateProcessTree } from '../processTree.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminateProcessTree', () => {
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
