import type { Memory, MemoryInput } from './MemoryTypes.js';
import type { MemoryStore } from './MemoryStore.js';

export class MemoryManager {
  constructor(private readonly store: MemoryStore) {}

  async save(memory: MemoryInput): Promise<Memory> {
    return this.store.save(memory);
  }

  async get(name: string): Promise<Memory | undefined> {
    return this.store.get(name);
  }

  private sortMemories(memories: Memory[]): Memory[] {
    return [...memories].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(): Promise<Memory[]> {
    const memories = await this.store.list();
    return this.sortMemories(memories);
  }

  async delete(name: string): Promise<void> {
    await this.store.delete(name);
  }

  async search(query: string): Promise<Memory[]> {
    const q = query.toLowerCase();
    const memories = await this.list();
    return memories.filter(
      (memory) =>
        memory.name.toLowerCase().includes(q) ||
        memory.description.toLowerCase().includes(q) ||
        memory.body.toLowerCase().includes(q)
    );
  }

  async readIndexContent(): Promise<string> {
    const memories = await this.list();
    if (memories.length === 0) return '(no memories saved)';
    return memories
      .map((memory) => `- [${memory.name}](${memory.name}) — ${memory.description}`)
      .join('\n');
  }
}
