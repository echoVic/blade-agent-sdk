import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotManager } from '../SnapshotManager.js';

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

describe('SnapshotManager', () => {
  it('acts as a no-op when storageRoot is not provided', async () => {
    const workspace = await createTempDir('blade-snapshot-workspace-');
    const filePath = join(workspace, 'example.ts');
    await writeFile(filePath, 'console.log("hi")\n', 'utf8');

    const manager = new SnapshotManager({ sessionId: 'session-noop' });

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
    const workspace = await createTempDir('blade-snapshot-storage-');
    const storageRoot = await createTempDir('blade-snapshot-root-');
    const filePath = join(workspace, 'example.ts');
    await writeFile(filePath, 'export const value = 1;\n', 'utf8');

    const manager = new SnapshotManager({
      sessionId: 'session-files',
      storageRoot,
    });

    await manager.initialize();
    const metadata = await manager.createSnapshot(filePath, 'message-1');

    const snapshotPath = join(
      storageRoot,
      'file-history',
      'session-files',
      `${metadata.backupFileName}@v${metadata.version}`
    );

    expect(await pathExists(snapshotPath)).toBe(true);
    expect(await readFile(snapshotPath, 'utf8')).toBe('export const value = 1;\n');
    expect(manager.getSnapshotDir()).toBe(join(storageRoot, 'file-history', 'session-files'));
    expect(manager.getSnapshotCount()).toBe(1);
    expect(manager.getTrackedFileCount()).toBe(1);
  });
});
