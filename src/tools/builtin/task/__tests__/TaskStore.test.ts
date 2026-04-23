import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../../types/branded.js';
import { TaskStore } from '../TaskStore.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'blade-task-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TaskStore', () => {
  it('isolates tasks by session id', async () => {
    const sessionA = SessionId(`session-a-${Date.now()}`);
    const sessionB = SessionId(`session-b-${Date.now()}`);
    const storeA = TaskStore.getInstance(sessionA);
    const storeB = TaskStore.getInstance(sessionB);

    const taskA = await storeA.create({
      subject: 'Task A',
      description: 'Description A',
    });

    expect(await storeA.get(taskA.id)).toMatchObject({
      id: taskA.id,
      subject: 'Task A',
      status: 'pending',
    });
    expect(await storeB.get(taskA.id)).toBeUndefined();
    expect(await storeB.list()).toEqual([]);
  });

  it('updates dependencies, merges metadata, and deletes tasks', async () => {
    const sessionId = SessionId(`session-${Date.now()}`);
    const store = TaskStore.getInstance(sessionId);

    const dependency = await store.create({
      subject: 'Dependency',
      description: 'Finish first',
    });
    const task = await store.create({
      subject: 'Main task',
      description: 'Depends on another task',
      metadata: { source: 'test' },
    });

    const updated = await store.update(task.id, {
      status: 'in_progress',
      owner: 'agent-1',
      metadata: { priority: 'high' },
      addBlockedBy: [dependency.id],
    });

    expect(updated).toMatchObject({
      id: task.id,
      status: 'in_progress',
      owner: 'agent-1',
      metadata: {
        source: 'test',
        priority: 'high',
      },
      blockedBy: [dependency.id],
    });

    const refreshedDependency = await store.get(dependency.id);
    expect(refreshedDependency?.blocks).toEqual([task.id]);

    await store.delete(task.id);

    expect(await store.get(task.id)).toBeUndefined();
    expect(await store.list()).toEqual([refreshedDependency]);
  });

  it('persists tasks when configDir is provided', async () => {
    const sessionId = SessionId(`persisted-session-${Date.now()}`);
    const configDir = await createTempDir();
    const store = TaskStore.getInstance(sessionId, configDir);

    const task = await store.create({
      subject: 'Persist task',
      description: 'Should be written to disk',
    });

    const persistedPath = path.join(configDir, 'tasks', `${sessionId}.json`);
    const persistedData = JSON.parse(await readFile(persistedPath, 'utf-8'));

    expect(persistedData).toEqual([
      expect.objectContaining({
        id: task.id,
        subject: 'Persist task',
        status: 'pending',
      }),
    ]);
  });
});
