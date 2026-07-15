import { describe, expect, it } from 'vitest';
import {
  createMemoryReadTool,
  createMemoryWriteTool,
  getBuiltinTools,
} from '../local/builtin-tools.js';
import {
  MemoryManager,
  type Memory,
  type MemoryInput,
  type MemoryStore,
} from '../local/memory.js';
import type { SessionOptions } from '../session/types.js';

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

describe('agent-sdk local memory tools', () => {
  it('registers package-local memory tools only when a manager is provided', async () => {
    const manager = new MemoryManager(new InMemoryStore());

    await expect(getBuiltinTools()).resolves.toMatchObject([{ name: 'Edit' }, { name: 'Read' }, { name: 'Write' }, { name: 'Grep' }, { name: 'Glob' }, { name: 'NotebookEdit' }, { name: 'AskUserQuestion' }, { name: 'EnterPlanMode' }, { name: 'ExitPlanMode' }, { name: 'TodoWrite' }, { name: 'DiscoverTools' }, { name: 'Skill' }, { name: 'WebFetch' }, { name: 'WebSearch' }]);
    const tools = await getBuiltinTools({ memoryManager: manager });
    const sessionOptions = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      },
      model: 'test-model',
      tools,
    } satisfies SessionOptions;

    expect(sessionOptions.tools).toBe(tools);
    expect(tools).toMatchObject([
      { name: 'Edit' },
      { name: 'Read' },
      { name: 'Write' },
      { name: 'Grep' },
      { name: 'Glob' },
      { name: 'NotebookEdit' },
      { name: 'AskUserQuestion' },
      { name: 'EnterPlanMode' },
      { name: 'ExitPlanMode' },
      { name: 'TodoWrite' },
      { name: 'DiscoverTools' },
      { name: 'Skill' },
      { name: 'WebFetch' },
      { name: 'WebSearch' },
      { name: 'MemoryRead' },
      { name: 'MemoryWrite' },
    ]);
  });

  it('read and write tools operate on the package-local memory manager', async () => {
    const manager = new MemoryManager(new InMemoryStore());
    const readTool = createMemoryReadTool({ manager });
    const writeTool = createMemoryWriteTool({ manager });

    await expect(
      executeTool(writeTool, {
        operation: 'save',
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
        body: 'Keep local memory tools package-owned.',
      }),
    ).resolves.toMatchObject({
      success: true,
      llmContent: {
        name: 'project-context',
        description: 'Repository conventions',
        type: 'project',
      },
    });

    await expect(executeTool(readTool, { operation: 'list' })).resolves.toMatchObject({
      success: true,
      llmContent: [
        {
          name: 'project-context',
          description: 'Repository conventions',
          type: 'project',
          updatedAt: 1,
        },
      ],
    });
    await expect(
      executeTool(readTool, { operation: 'search', query: 'package-owned' }),
    ).resolves.toMatchObject({
      success: true,
      llmContent: [
        {
          name: 'project-context',
          description: 'Repository conventions',
          type: 'project',
          updatedAt: 1,
        },
      ],
    });
  });
});
