import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createTodoWriteTool, todoWriteTool } from '../local/todo/index.js';
import { TodoManager } from '../local/todo/TodoManager.js';
import { ToolKind } from '../tools/types/ToolKind.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe('agent-sdk local todo tools', () => {
  it('includes the TodoWrite tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('TodoWrite');
  });

  it('creates a TodoWrite tool via factory function', () => {
    const tool = createTodoWriteTool({ sessionId: 'test-session' });
    expect(tool.name).toBe('TodoWrite');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('exports a default todoWriteTool instance', () => {
    expect(todoWriteTool.name).toBe('TodoWrite');
    expect(todoWriteTool.displayName).toBe('Todo Write');
  });

  it('TodoWrite tool accepts valid build params', () => {
    const tool = createTodoWriteTool({ sessionId: 'test-session' });
    const invocation = tool.build({
      todos: [
        {
          content: 'Write tests',
          activeForm: 'Writing tests',
          status: 'pending',
          priority: 'high',
        },
      ],
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });
});

describe('TodoManager', () => {
  it('updates todos in memory when configDir is not provided', async () => {
    const manager = TodoManager.getInstance(`memory-${Date.now()}`);

    await manager.updateTodos([
      {
        content: 'Write tests',
        activeForm: 'Writing tests',
        status: 'in_progress',
      },
      {
        content: 'Verify results',
        activeForm: 'Verifying results',
        status: 'pending',
      },
    ]);

    const todos = manager.getTodos();
    expect(todos.map((todo) => todo.content)).toEqual(['Write tests', 'Verify results']);
    expect(todos[0]?.status).toBe('in_progress');
    expect(todos[0]?.startedAt).toBeDefined();
  });

  it('persists todos under configDir when configured', async () => {
    const configDir = await createTempDir('blade-todo-config-');
    const sessionId = `persist-${Date.now()}`;
    const manager = TodoManager.getInstance(sessionId, configDir);

    await manager.updateTodos([
      {
        content: 'Write tests',
        activeForm: 'Writing tests',
        status: 'completed',
      },
    ]);

    const todoPath = join(configDir, 'todos', `${sessionId}-agent-${sessionId}.json`);
    const fs = await import('node:fs/promises');
    expect(await pathExists(todoPath)).toBe(true);
    expect(JSON.parse(await fs.readFile(todoPath, 'utf8'))).toMatchObject([
      { content: 'Write tests', status: 'completed' },
    ]);
  });
});
