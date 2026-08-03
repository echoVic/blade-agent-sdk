import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { SessionId } from '../local/branded.js';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SnapshotManager,
  type SnapshotManagerOptions,
} from '../local/file/snapshotManager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildOptions(overrides: Partial<SnapshotManagerOptions> = {}): SnapshotManagerOptions {
  return {
    sessionId: SessionId('package-session'),
    ...overrides,
  };
}

describe('package-local SnapshotManager', () => {
  it('acts as no-op when storageRoot is not provided', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-noop-');
    const filePath = join(workspace, 'example.ts');
    await writeFile(filePath, 'console.log("hi")\n', 'utf8');

    const manager = new SnapshotManager(buildOptions({ sessionId: SessionId('session-noop') }));

    await manager.initialize();
    const metadata = await manager.createSnapshot(filePath, 'message-1');
    await manager.restoreSnapshot(filePath, 'message-1');

    expect(manager.getSnapshotDir()).toBeUndefined();
    expect(metadata.backupFileName).toBe('');
    expect(metadata.version).toBe(0);
    expect(manager.getSnapshotCount()).toBe(0);
    expect(manager.getTrackedFileCount()).toBe(0);
  });

  it('stores snapshots under storageRoot when enabled', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-storage-');
    const storageRoot = await createTempDir('blade-pkg-snapshot-root-');
    const filePath = join(workspace, 'example.ts');
    await writeFile(filePath, 'export const value = 1;\n', 'utf8');

    const manager = new SnapshotManager(
      buildOptions({ sessionId: SessionId('session-files'), storageRoot }),
    );

    await manager.initialize();
    const metadata = await manager.createSnapshot(filePath, 'message-1');

    const snapshotPath = join(
      storageRoot,
      'file-history',
      'session-files',
      `${metadata.backupFileName}@v${metadata.version}`,
    );

    expect(await pathExists(snapshotPath)).toBe(true);
    expect(await readFile(snapshotPath, 'utf8')).toBe('export const value = 1;\n');
    expect(manager.getSnapshotDir()).toBe(
      join(storageRoot, 'file-history', 'session-files'),
    );
    expect(manager.getSnapshotCount()).toBe(1);
    expect(manager.getTrackedFileCount()).toBe(1);
  });

  it('increments version on repeated snapshots of the same file', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-versions-');
    const storageRoot = await createTempDir('blade-pkg-snapshot-version-root-');
    const filePath = join(workspace, 'example.ts');

    await writeFile(filePath, 'v1\n', 'utf8');
    const manager = new SnapshotManager(
      buildOptions({ sessionId: SessionId('session-versions'), storageRoot }),
    );
    await manager.initialize();

    const meta1 = await manager.createSnapshot(filePath, 'message-1');
    expect(meta1.version).toBe(1);
    expect(meta1.backupFileName).not.toBe('');

    await writeFile(filePath, 'v2\n', 'utf8');
    const meta2 = await manager.createSnapshot(filePath, 'message-2');
    expect(meta2.version).toBe(2);
    // backupFileName changes per-version since the hash seed includes version
    expect(meta2.backupFileName).not.toBe('');
    expect(manager.getSnapshotCount()).toBe(2);
    expect(manager.getTrackedFileCount()).toBe(1);
  });

  it('restores snapshot content for the latest version', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-restore-');
    const storageRoot = await createTempDir('blade-pkg-snapshot-restore-root-');
    const filePath = join(workspace, 'example.ts');

    await writeFile(filePath, 'original\n', 'utf8');
    const manager = new SnapshotManager(
      buildOptions({ sessionId: SessionId('session-restore'), storageRoot }),
    );
    await manager.initialize();

    await manager.createSnapshot(filePath, 'message-1');
    expect(await readFile(filePath, 'utf8')).toBe('original\n');

    await writeFile(filePath, 'modified\n', 'utf8');
    await manager.restoreSnapshot(filePath, 'message-1');
    expect(await readFile(filePath, 'utf8')).toBe('original\n');
  });

  it('lists snapshots for a specific file', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-list-');
    const storageRoot = await createTempDir('blade-pkg-snapshot-list-root-');
    const filePath = join(workspace, 'example.ts');

    await writeFile(filePath, 'first\n', 'utf8');
    const manager = new SnapshotManager(
      buildOptions({ sessionId: SessionId('session-list'), storageRoot }),
    );
    await manager.initialize();

    await manager.createSnapshot(filePath, 'message-1');
    await manager.createSnapshot(filePath, 'message-2');

    const snapshots = await manager.listSnapshots(filePath);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.filePath === filePath)).toBe(true);
  });

  it('cleans up old snapshots respecting maxSnapshots', async () => {
    const workspace = await createTempDir('blade-pkg-snapshot-cleanup-');
    const storageRoot = await createTempDir('blade-pkg-snapshot-cleanup-root-');
    const filePath = join(workspace, 'example.ts');

    const manager = new SnapshotManager(
      buildOptions({ sessionId: SessionId('session-cleanup'), storageRoot, maxSnapshots: 2 }),
    );
    await manager.initialize();

    for (const v of ['a', 'b', 'c']) {
      await writeFile(filePath, `${v}\n`, 'utf8');
      await manager.createSnapshot(filePath, `message-${v}`);
    }

    // Should only keep the most recent 2
    const snapshots = await manager.listSnapshots(filePath);
    expect(snapshots.length).toBeLessThanOrEqual(2);
  });

  it('getSessionId returns the session id', () => {
    const manager = new SnapshotManager(buildOptions({ sessionId: SessionId('session-id-check') }));
    expect(manager.getSessionId()).toBe('session-id-check');
  });
});
