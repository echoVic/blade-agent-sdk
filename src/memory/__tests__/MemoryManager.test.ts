import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../MemoryManager.js';
import type { MemoryStore } from '../MemoryStore.js';
import type { Memory, MemoryInput } from '../MemoryTypes.js';

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

describe('MemoryManager', () => {
  it('searches and renders index content without filesystem metadata', async () => {
    const store = new FakeMemoryStore();
    const manager = new MemoryManager(store);

    await manager.save({
      name: 'project-context',
      description: 'Repository conventions',
      type: 'project',
      body: 'Use session scoped subagents and opt-in memory tools.',
    });

    await manager.save({
      name: 'user-preferences',
      description: 'Product boundaries',
      type: 'user',
      body: 'Do not make storage or reviewer decisions inside the SDK.',
    });

    const results = await manager.search('reviewer');
    expect(results).toEqual([
      expect.objectContaining({
        name: 'user-preferences',
        description: 'Product boundaries',
      }),
    ]);

    expect(await manager.readIndexContent()).toBe(
      '- [project-context](project-context) — Repository conventions\n' +
      '- [user-preferences](user-preferences) — Product boundaries'
    );
  });

  it('deletes records through the injected store', async () => {
    const store = new FakeMemoryStore();
    const manager = new MemoryManager(store);

    await manager.save({
      name: 'temporary-note',
      description: 'delete me',
      type: 'feedback',
      body: 'This memory should disappear.',
    });

    await manager.delete('temporary-note');

    expect(await manager.get('temporary-note')).toBeUndefined();
    expect(await manager.list()).toEqual([]);
  });
});
