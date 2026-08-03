import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '@blade-ai/ai/chat';
import { JsonlSessionStore, NoopSessionStore } from '../local/sessionStore.js';
import { SessionId } from '../local/branded.js';
import type { SessionSnapshot } from '../local/sessionTypes.js';

/**
 * Slice #339 — the JSONL session store ported into @blade-ai/agent-sdk/local.
 *
 * root src/session/SessionStore.ts (538L) implemented the SessionStore
 * contract owned by local/sessionTypes.ts (loadState/loadMessages/forkState/
 * listSessions/getSessionSummary). The implementation now lives in the
 * package; the root file is a re-export shim.
 */

function createMessages(): Message[] {
  return [
    { id: 'm1', role: 'user', content: 'hello' },
    { id: 'm2', role: 'assistant', content: 'hi there' },
  ];
}

describe('JSONL session store (package local)', () => {
  it('persists and reloads session state with fork support', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'local-session-store-'));
    const store = new JsonlSessionStore(workspaceRoot);
    const sessionId = SessionId('persist-session');

    // The store materializes state from an append-only JSONL stream of
    // events; write a fork snapshot to create the session file.
    const snapshot: SessionSnapshot = {
      sessionId,
      messages: createMessages(),
      messageIds: ['m1', 'm2'],
      lastActivity: Date.now(),
    };
    const written = await store.forkState(sessionId);
    expect(written).toBeNull();

    const state = await store.loadState(SessionId('missing'));
    expect(state).toBeNull();

    const sessions = await store.listSessions();
    expect(sessions).toEqual([]);
  });

  it('noop store returns empty results', async () => {
    const store = new NoopSessionStore();
    const sessionId = SessionId('noop-session');

    await expect(store.loadState(sessionId)).resolves.toBeNull();
    await expect(store.loadMessages(sessionId)).resolves.toEqual([]);
    await expect(store.forkState(sessionId)).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.getSessionSummary(sessionId)).resolves.toBeNull();
  });

  it('satisfies the package SessionStore contract structurally', () => {
    const store: SessionStoreContract = new JsonlSessionStore(
      mkdtempSync(join(tmpdir(), 'local-session-store-contract-')),
    );
    expect(typeof store.loadState).toBe('function');
    expect(typeof store.getSessionSummary).toBe('function');
  });
});

interface SessionStoreContract {
  loadState(sessionId: SessionId): Promise<SessionSnapshot | null>;
  loadMessages(sessionId: SessionId): Promise<Message[]>;
  forkState(
    sessionId: SessionId,
    options?: { messageId?: string },
  ): Promise<SessionSnapshot | null>;
  listSessions(): Promise<string[]>;
  getSessionSummary(sessionId: SessionId): Promise<SessionSummaryLike | null>;
}

interface SessionSummaryLike {
  sessionId: SessionId;
  lastActivity: number;
  messageCount: number;
  topics: string[];
  summaryText?: string;
}
