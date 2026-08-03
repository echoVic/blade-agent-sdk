import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoopPersistentStore, PersistentStore } from '../local/persistentStore.js';
import { SessionId } from '../local/branded.js';

/**
 * Slice #340 — the JSONL persistent store ported into @blade-ai/agent-sdk/local.
 *
 * root src/context/storage/PersistentStore.ts (841L) — the durable
 * project-scoped session store ({storageRoot}/projects/{path}/{sessionId}.jsonl)
 * with initialize/createSession/saveMessage/saveToolUse/saveToolResult/
 * saveCompaction/loadSession/loadConversation/listSessions/deleteSession/
 * cleanupOldSessions/getStorageStats/checkStorageHealth — now lives in the
 * package; the root file is a re-export shim.
 */

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'local-persistent-store-'));
}

describe('PersistentStore (package local)', () => {
  it('initializes, persists and loads a session with messages', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();

    const sessionId = SessionId('ps-session');
    await store.createSession(sessionId);

    await store.saveMessage(sessionId, 'user', 'hello persistent store');

    const session = await store.loadSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe('ps-session');

    const conversation = await store.loadConversation(sessionId);
    expect(conversation).not.toBeNull();

    const sessions = await store.listSessions();
    expect(sessions).toContain('ps-session');

    const stats = await store.getStorageStats();
    expect(stats.totalSessions).toBeGreaterThan(0);

    await store.deleteSession(sessionId);
    await expect(store.loadSession(sessionId)).resolves.toBeNull();
  });

  it('noop store is inert', async () => {
    const store = new NoopPersistentStore();
    await store.initialize();

    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.loadSession(SessionId('missing'))).resolves.toBeNull();
    await expect(store.loadConversation(SessionId('missing'))).resolves.toBeNull();
  });

  it('reports storage health', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const store = new PersistentStore(workspaceRoot);
    await store.initialize();

    await expect(store.checkStorageHealth()).resolves.toEqual(
      expect.objectContaining({ isAvailable: true, canWrite: true }),
    );
  });
});
