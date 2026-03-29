import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TodoManager } from '../TodoManager.js';

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
    expect(await pathExists(todoPath)).toBe(true);
    expect(JSON.parse(await readFile(todoPath, 'utf8'))).toMatchObject([
      { content: 'Write tests', status: 'completed' },
    ]);
  });
});
