import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageId, SessionId } from '../../../../types/identifiers.js';
import { FileAccessTracker } from '../FileAccessTracker.js';
import { runWriteGuard } from '../writeGuard.js';

const tempDirs: string[] = [];

afterEach(async () => {
  FileAccessTracker.resetInstance();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it('surfaces a non-fatal snapshot failure in result metadata', async () => {
    FileAccessTracker.resetInstance();
    const root = await mkdtemp(join(tmpdir(), 'write-guard-warning-'));
    tempDirs.push(root);
    const filePath = join(root, 'target.txt');
    const invalidStorageRoot = join(root, 'not-a-directory');
    await writeFile(filePath, 'content');
    await writeFile(invalidStorageRoot, 'file');
    const sessionId = SessionId('snapshot-warning-session');
    await FileAccessTracker.getInstance().recordFileRead(filePath, sessionId, 'content');

    const result = await runWriteGuard({
      filePath,
      sessionId,
      messageId: MessageId('message-1'),
      operation: 'write',
      fileExists: true,
      storageRoot: invalidStorageRoot,
    });

    expect(result.blocked).toBeNull();
    expect(result.snapshotCreated).toBe(false);
    expect(result.snapshotWarning).toBeTruthy();
  });
});
