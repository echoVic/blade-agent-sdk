import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../../index.js';
import { MemoryManager } from '../../../../memory/MemoryManager.js';
import type { MemoryStore } from '../../../../memory/MemoryStore.js';
import type { Memory, MemoryInput } from '../../../../memory/MemoryTypes.js';
import { createMemoryReadTool, createMemoryWriteTool } from '../index.js';

class InMemoryStore implements MemoryStore {
  private readonly records = new Map<string, Memory>();
  private clock = 1;

  async save(memory: MemoryInput): Promise<Memory> {
    const stored = { ...memory, updatedAt: this.clock++ };
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

async function executeTool<TParams>(
  tool: ReturnType<typeof createMemoryReadTool> | ReturnType<typeof createMemoryWriteTool>,
  params: TParams,
) {
  return tool.build(params as never).execute(new AbortController().signal);
}

describe('memory tools', () => {
  it('does not register memory tools by default', async () => {
    const tools = await getBuiltinTools({ sessionId: 'memory-default' });
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['MemoryRead', 'MemoryWrite'])
    );
  });

  it('registers memory tools only when a manager is provided', async () => {
    const manager = new MemoryManager(new InMemoryStore());
    const tools = await getBuiltinTools({
      sessionId: 'memory-opt-in',
      memoryManager: manager,
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['MemoryRead', 'MemoryWrite'])
    );
  });

  it('returns summaries for list and search operations', async () => {
    const manager = new MemoryManager(new InMemoryStore());
    const readTool = createMemoryReadTool({ manager });

    await manager.save({
      name: 'project-context',
      description: 'Repository conventions',
      type: 'project',
      body: 'Use session scoped subagents and opt-in memory tools.',
    });

    const listResult = await executeTool(readTool, { operation: 'list' });
    const searchResult = await executeTool(readTool, {
      operation: 'search',
      query: 'session scoped',
    });

    expect(listResult.llmContent).toEqual([
      {
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
        updatedAt: 1,
      },
    ]);
    expect(searchResult.llmContent).toEqual([
      {
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
        updatedAt: 1,
      },
    ]);
  });

  it('requires operation-specific parameters at schema level', () => {
    const manager = new MemoryManager(new InMemoryStore());
    const readTool = createMemoryReadTool({ manager });
    const writeTool = createMemoryWriteTool({ manager });

    expect(() => readTool.build({ operation: 'get' } as never)).toThrow();
    expect(() => readTool.build({ operation: 'search' } as never)).toThrow();
    expect(() => writeTool.build({ operation: 'save', name: 'project-context' } as never)).toThrow();
  });

  it('acknowledges delete requests without claiming a missing record was deleted', async () => {
    const manager = new MemoryManager(new InMemoryStore());
    const writeTool = createMemoryWriteTool({ manager });

    const result = await executeTool(writeTool, {
      operation: 'delete',
      name: 'missing-memory',
    });

    expect(result.success).toBe(true);
    expect(result.llmContent).toEqual({
      name: 'missing-memory',
      deleteRequested: true,
    });
    expect(result.displayContent).toBe('Delete requested for memory "missing-memory".');
  });
});
