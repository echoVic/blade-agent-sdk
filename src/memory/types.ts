export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/**
 * MemoryInput describes the payload the manager accepts. `name` must be a stable,
 * unique slug that backends can safely use as a link target in generated indices.
 */
export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface Memory {
  /** The stable slug / identifier exposed throughout the memory tooling. */
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  updatedAt: number;
}
