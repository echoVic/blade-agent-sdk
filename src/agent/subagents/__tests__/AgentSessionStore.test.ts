import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentId } from '../../../types/branded.js';
import { type AgentSession, AgentSessionStore } from '../AgentSessionStore.js';

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

function createSession(id: string): AgentSession {
  return {
    id: AgentId(id),
    subagentType: 'research',
    description: 'Research task',
    prompt: 'Inspect the repo',
    messages: [],
    status: 'running',
    createdAt: 1,
    lastActiveAt: 2,
  };
}

describe('AgentSessionStore', () => {
  it('keeps sessions in memory when storageRoot is not configured', async () => {
    const fakeHome = await createTempDir('blade-agent-home-');

    const store = AgentSessionStore.create();
    store.saveSession(createSession('agent-memory'));

    expect(store.loadSession(AgentId('agent-memory'))?.id).toBe('agent-memory');
    expect(store.listSessions().map((session) => session.id)).toEqual(['agent-memory']);
    expect(await pathExists(join(fakeHome, '.blade', 'agents', 'sessions'))).toBe(false);
  });

  it('persists sessions under the configured storageRoot', async () => {
    const storageRoot = await createTempDir('blade-agent-storage-');

    const store = AgentSessionStore.create(storageRoot);
    store.saveSession(createSession('agent/unsafe:id'));

    const sessionPath = join(storageRoot, 'agents', 'sessions', 'agent_unsafe_id.json');
    expect(await pathExists(sessionPath)).toBe(true);
    expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({
      id: 'agent/unsafe:id',
      subagentType: 'research',
    });
  });
});
