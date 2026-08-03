import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryManager } from '../local/MemoryManager.js';
import {
  FileSystemMemoryStore,
  type Memory,
  type MemoryInput,
  type MemoryStore,
} from '../local/memory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blade-agent-sdk-memory-'));
  tempDirs.push(dir);
  return dir;
}

class FakeMemoryStore implements MemoryStore {
  private readonly records = new Map<string, Memory>();
  private clock = 1;

  async save(memory: MemoryInput): Promise<Memory> {
    const stored: Memory = {
      ...memory,
      updatedAt: this.clock++,
    };
    this.records.set(memory.name, stored);
    return stored;
  }

  async get(name: string): Promise<Memory | undefined> {
    return this.records.get(name);
  }

  async list(): Promise<Memory[]> {
    return [...this.records.values()];
  }

  async delete(name: string): Promise<void> {
    this.records.delete(name);
  }
}

describe('agent-sdk local memory adapter', () => {
  it('persists file-system memories and maintains MEMORY.md', async () => {
    const root = await createTempDir();
    const store = new FileSystemMemoryStore(root);

    await store.save({
      name: 'repo-context',
      description: 'SDK boundaries',
      type: 'project',
      body: 'Keep memory opt-in.',
    });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        name: 'repo-context',
        description: 'SDK boundaries',
        type: 'project',
      }),
    ]);
    await expect(readFile(join(root, 'MEMORY.md'), 'utf8')).resolves.toContain(
      '[repo-context](repo-context.md)',
    );
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

  it('searches and renders deterministic index content through MemoryManager', async () => {
    const store = new FakeMemoryStore();
    const manager = new MemoryManager(store);

    await manager.save({
      name: 'beta-note',
      description: 'Beta entry',
      type: 'feedback',
      body: 'Case-insensitive search test.',
    });
    await manager.save({
      name: 'alpha-note',
      description: 'Alpha entry',
      type: 'feedback',
      body: 'Another case-insensitive SEARCH test.',
    });

    await expect(manager.search('NOTE')).resolves.toMatchObject([
      { name: 'alpha-note' },
      { name: 'beta-note' },
    ]);
    await expect(manager.readIndexContent()).resolves.toBe(
      '- [alpha-note](alpha-note) — Alpha entry\n' +
      '- [beta-note](beta-note) — Beta entry',
    );
  });
});
