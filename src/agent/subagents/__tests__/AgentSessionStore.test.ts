import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentId,
  ExecutionLeaseId,
  FencingToken,
} from '../../../types/branded.js';
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
    await store.saveSession(createSession('agent-memory'));

    expect(store.loadSession(AgentId('agent-memory'))?.id).toBe('agent-memory');
    expect(store.listSessions().map((session) => session.id)).toEqual(['agent-memory']);
    expect(await pathExists(join(fakeHome, '.blade', 'agents', 'sessions'))).toBe(false);
  });

  it('persists sessions under the configured storageRoot', async () => {
    const storageRoot = await createTempDir('blade-agent-storage-');

    const store = AgentSessionStore.create(storageRoot);
    await store.saveSession(createSession('agent/unsafe:id'));

    const sessionPath = join(storageRoot, 'agents', 'sessions', 'agent_unsafe_id.json');
    expect(await pathExists(sessionPath)).toBe(true);
    expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({
      id: 'agent/unsafe:id',
      subagentType: 'research',
    });
  });

  it('rejects stale subagent writers after a fencing-token takeover', async () => {
    const storageRoot = await createTempDir('blade-agent-fenced-storage-');
    const store = AgentSessionStore.create(storageRoot);
    const agentId = AgentId('agent-fenced');
    const staleFence = {
      leaseId: ExecutionLeaseId('lease-stale'),
      fencingToken: FencingToken(1),
    };
    const successorFence = {
      leaseId: ExecutionLeaseId('lease-successor'),
      fencingToken: FencingToken(2),
    };

    await expect(store.saveSession({
      ...createSession(agentId),
      executionFence: staleFence,
    })).resolves.toBe(true);
    await expect(store.saveSession({
      ...createSession(agentId),
      description: 'Successor execution',
      executionFence: successorFence,
    })).resolves.toBe(true);

    await expect(
      store.markCancelled(agentId, undefined, undefined, staleFence),
    ).resolves.toBeUndefined();
    await expect(store.saveSession({
      ...createSession(agentId),
      description: 'Stale replacement',
      executionFence: staleFence,
    })).resolves.toBe(false);
    expect(store.loadSession(agentId)).toMatchObject({
      description: 'Successor execution',
      status: 'running',
      executionFence: successorFence,
    });
    await expect(store.deleteSession(agentId)).resolves.toBe(false);

    await expect(
      store.markCompleted(
        agentId,
        { success: true, message: 'done' },
        undefined,
        successorFence,
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    await expect(store.cleanupExpiredSessions(0)).resolves.toBe(1);
    expect(store.loadSession(agentId)).toBeUndefined();
  });

  it('serializes fencing-token takeovers across Store instances', async () => {
    const storageRoot = await createTempDir('blade-agent-fence-race-');
    const firstStore = AgentSessionStore.create(storageRoot);
    const secondStore = AgentSessionStore.create(storageRoot);
    const agentId = AgentId('agent-fence-race');
    await firstStore.saveSession({
      ...createSession(agentId),
      executionFence: {
        leaseId: ExecutionLeaseId('lease-1'),
        fencingToken: FencingToken(1),
      },
    });

    await Promise.all([
      firstStore.saveSession({
        ...createSession(agentId),
        description: 'token 2',
        executionFence: {
          leaseId: ExecutionLeaseId('lease-2'),
          fencingToken: FencingToken(2),
        },
      }),
      secondStore.saveSession({
        ...createSession(agentId),
        description: 'token 3',
        executionFence: {
          leaseId: ExecutionLeaseId('lease-3'),
          fencingToken: FencingToken(3),
        },
      }),
    ]);

    expect(firstStore.loadSession(agentId)).toMatchObject({
      description: 'token 3',
      executionFence: {
        leaseId: 'lease-3',
        fencingToken: 3,
      },
    });
  });
});
