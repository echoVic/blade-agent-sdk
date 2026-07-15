import type { Memory, MemoryInput } from './memory.js';

export interface MemoryStore {
  save(memory: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
}
