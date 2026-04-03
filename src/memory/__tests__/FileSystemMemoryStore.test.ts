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
      name: 'repo-context',
      description: 'SDK boundaries',
      type: 'project',
      body: 'Keep memory opt-in.',
    });

    const records = await store.list();
    expect(records).toEqual([
      expect.objectContaining({
        name: 'repo-context',
        description: 'SDK boundaries',
        type: 'project',
      }),
    ]);

    const index = await readFile(join(root, 'MEMORY.md'), 'utf8');
    expect(index).toContain('[repo-context](repo-context.md)');
  });

  it('deletes persisted records and removes them from the index', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await store.save({
      name: 'delete-me',
      description: 'temporary memory',
      type: 'feedback',
      body: 'remove this entry',
    });

    await store.delete('delete-me');

    expect(await store.get('delete-me')).toBeUndefined();
    expect(await store.list()).toEqual([]);

    const index = await readFile(join(root, 'MEMORY.md'), 'utf8');
    expect(index.trim()).toBe('');
  });

  it('rejects non-slug names before writing files', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await expect(
      store.save({
        name: 'Invalid Name',
        description: 'should fail',
        type: 'feedback',
        body: 'no slugs allowed',
      })
    ).rejects.toThrow(/slug/);

    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(join(root, 'MEMORY.md'), 'utf8')).rejects.toThrow();
  });
});
