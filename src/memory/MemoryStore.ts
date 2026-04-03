import type { Memory, MemoryInput } from './MemoryTypes.js';

export interface MemoryStore {
  save(memory: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
}
