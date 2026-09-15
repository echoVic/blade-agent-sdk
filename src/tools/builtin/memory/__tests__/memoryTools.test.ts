import { describe, expect, it } from 'vitest';
import { MemoryManager } from '../../../../memory/MemoryManager.js';
import type { MemoryStore } from '../../../../memory/MemoryStore.js';
import type { Memory, MemoryInput } from '../../../../memory/types.js';
import type { JsonObject } from '../../../../types/json.js';
import { ExecutionPipeline } from '../../../execution/ExecutionPipeline.js';
import { ToolRegistry } from '../../../registry/ToolRegistry.js';
import { collectToolExecution } from '../../../types/result.js';
import { createBuiltinToolGroups, flattenBuiltinToolGroups } from '../../groups.js';
import { memoryReadTool, memoryWriteTool } from '../index.js';

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

async function executeTool(
  tool: typeof memoryReadTool | typeof memoryWriteTool,
  params: JsonObject,
  manager: MemoryManager,
) {
  const registry = new ToolRegistry({ memoryManager: manager });
  registry.register(tool);
  return collectToolExecution(new ExecutionPipeline(registry).execute(tool.name, params, {}));
}

describe('memory tools', () => {
  it('does not register memory tools by default', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(flattenBuiltinToolGroups(createBuiltinToolGroups()));
    expect(registry.getAll().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['MemoryRead', 'MemoryWrite']),
    );
  });

  it('registers memory tools only when a manager is provided', async () => {
    const manager = new MemoryManager(new InMemoryStore());
    const registry = new ToolRegistry({ memoryManager: manager });
    registry.registerAll(flattenBuiltinToolGroups(createBuiltinToolGroups()));

    expect(registry.getAll().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['MemoryRead', 'MemoryWrite']),
    );
  });

  it('returns summaries for list and search operations', async () => {
    const manager = new MemoryManager(new InMemoryStore());

    await manager.save({
      name: 'project-context',
      description: 'Repository conventions',
      type: 'project',
      body: 'Use session scoped subagents and opt-in memory tools.',
    });

    const listResult = await executeTool(memoryReadTool, { operation: 'list' }, manager);
    const searchResult = await executeTool(
      memoryReadTool,
      {
        operation: 'search',
        query: 'session scoped',
      },
      manager,
    );

    expect(listResult.model).toEqual([
      {
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
        updatedAt: 1,
      },
    ]);
    expect(searchResult.model).toEqual([
      {
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
        updatedAt: 1,
      },
    ]);
  });

  it('requires operation-specific parameters at schema level', () => {
    expect(() => memoryReadTool.build({ operation: 'get' } as never)).toThrow();
    expect(() => memoryReadTool.build({ operation: 'search' } as never)).toThrow();
    expect(() =>
      memoryWriteTool.build({ operation: 'save', name: 'project-context' } as never),
    ).toThrow();
  });

  it('acknowledges delete requests without claiming a missing record was deleted', async () => {
    const manager = new MemoryManager(new InMemoryStore());

    const result = await executeTool(
      memoryWriteTool,
      {
        operation: 'delete',
        name: 'missing-memory',
      },
      manager,
    );

    expect(result.status).toBe('success');
    expect(result.model).toEqual({
      name: 'missing-memory',
      deleteRequested: true,
    });
  });
});
