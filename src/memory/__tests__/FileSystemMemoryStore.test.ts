import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSystemMemoryStore } from '../FileSystemMemoryStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blade-memory-'));
  tempDirs.push(dir);
  return dir;
}

describe('FileSystemMemoryStore', () => {
  it('persists memory records and updates MEMORY.md', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await store.save({
      name: 'Repo Context',
      description: 'SDK boundaries',
      type: 'project',
      body: 'Keep memory opt-in.',
    });

    const records = await store.list();
    expect(records).toEqual([
      expect.objectContaining({
        name: 'Repo Context',
        description: 'SDK boundaries',
        type: 'project',
      }),
    ]);

    const index = await readFile(join(root, 'MEMORY.md'), 'utf8');
    expect(index).toContain('[Repo Context](repo-context.md)');
  });

  it('deletes persisted records and removes them from the index', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await store.save({
      name: 'Delete Me',
      description: 'temporary memory',
      type: 'feedback',
      body: 'remove this entry',
    });

    await store.delete('Delete Me');

    expect(await store.get('Delete Me')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
