import { describe, expect, it } from 'vitest';
import { runWriteGuard } from '../writeGuard.js';

describe('runWriteGuard', () => {
  it('fails closed for an existing file when Session identity is unavailable', async () => {
    const result = await runWriteGuard({
      filePath: '/tmp/existing.txt',
      operation: 'write',
      fileExists: true,
    });

    expect(result).toMatchObject({
      blocked: {
        status: 'error',
        error: {
          type: 'permission_denied',
          message: 'Session ID required for existing file writes',
        },
        metadata: {
          requiresRead: true,
          requiresSession: true,
        },
      },
      snapshotCreated: false,
    });
  });

  it('does not require Session identity when creating a new file', async () => {
    await expect(
      runWriteGuard({
        filePath: '/tmp/new.txt',
        operation: 'write',
        fileExists: false,
      }),
    ).resolves.toEqual({
      blocked: null,
      snapshotCreated: false,
    });
  });
});
