import { mkdtemp, readFile, rm as remove, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('FileSystemMemoryStore concurrency and recovery', () => {
  it('keeps every memory when saves run concurrently', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await Promise.all([
      store.save({ name: 'alpha', description: 'first', type: 'project', body: 'a' }),
      store.save({ name: 'beta', description: 'second', type: 'project', body: 'b' }),
      store.save({ name: 'gamma', description: 'third', type: 'project', body: 'c' }),
    ]);

    // Every file exists, so every memory must be listed and searchable.
    const names = (await store.list()).map((memory) => memory.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('recovers memories when the index is deleted', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);
    await store.save({ name: 'alpha', description: 'first', type: 'project', body: 'a' });
    await store.save({ name: 'beta', description: 'second', type: 'project', body: 'b' });

    await remove(join(root, 'MEMORY.md'));

    // The files are the authority, so the index is not required to find them.
    expect((await store.list()).map((memory) => memory.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('repairs a corrupted index from the files on rebuild', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);
    await store.save({ name: 'alpha', description: 'first', type: 'project', body: 'a' });

    await writeFile(join(root, 'MEMORY.md'), 'not an index at all\n', 'utf8');
    await store.rebuildIndex();

    const index = await readFile(join(root, 'MEMORY.md'), 'utf8');
    expect(index).toContain('[alpha](alpha.md)');
    expect(index).toContain('first');
  });

  it('reports a read failure instead of pretending the memory is absent', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    // A directory where the memory file is expected: reading it fails, which is
    // not the same fact as "no such memory".
    await store.save({ name: 'alpha', description: 'first', type: 'project', body: 'a' });
    await rm(join(root, 'alpha.md'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'alpha.md'), { recursive: true });

    await expect(store.get('alpha')).rejects.toThrow();
    expect(await store.get('missing')).toBeUndefined();
  });

  it('reports the file modification time rather than the read time', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);
    await store.save({ name: 'alpha', description: 'first', type: 'project', body: 'a' });

    const first = await store.get('alpha');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await store.get('alpha');

    // Two reads of an unchanged file must agree. Returning the read time would
    // make `updatedAt` advance on every read and hide when the memory changed.
    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(first?.updatedAt).toBeLessThanOrEqual(Date.now());
  });
});

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
      }),
    ).rejects.toThrow(/slug/);

    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(join(root, 'MEMORY.md'), 'utf8')).rejects.toThrow();
  });
});
