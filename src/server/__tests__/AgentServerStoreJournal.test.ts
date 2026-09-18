import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/index.js';
import { CommandId, SessionId } from '../../types/identifiers.js';
import {
  type AgentServerStoreJournalEntry,
  InMemoryAgentServerStore,
} from '../AgentServerStore.js';
import { RuntimeStoreError } from '../RuntimeStore.js';

const tenantId = 'tenant-journal';
const sessionId = SessionId('session-journal');

function record(id: string) {
  return {
    tenantId,
    createdBy: 'user-a',
    sessionId: SessionId(id),
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function event(delta: string) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type: 'session.stream' as const,
    data: { type: 'content' as const, delta, sessionId },
  };
}

function recordingJournal() {
  const entries: AgentServerStoreJournalEntry[] = [];
  return {
    entries,
    journal: {
      async append(entry: AgentServerStoreJournalEntry) {
        entries.push(structuredClone(entry));
      },
    },
  };
}

describe('InMemoryAgentServerStore journal', () => {
  it('records every state change in order and skips idempotent repeats', async () => {
    const { entries, journal } = recordingJournal();
    let now = 1000;
    const store = new InMemoryAgentServerStore({ journal, now: () => now });
    await store.putSession(record('session-journal'));
    const claim = await store.claimCommand(tenantId, CommandId('command-1'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await store.sealCommand(tenantId, CommandId('command-1'), claim.leaseId);
    await store.completeCommand(tenantId, CommandId('command-1'), claim.leaseId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: CommandId('command-1'),
      ok: true,
      data: {},
    });
    const released = await store.claimCommand(tenantId, CommandId('command-2'), 'fp', 100);
    if (released.status !== 'claimed') throw new Error('expected a claim');
    await store.releaseCommand(tenantId, CommandId('command-2'), released.leaseId);
    const first = await store.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'k-1',
    });
    await store.appendEvent(tenantId, sessionId, event('one'), { idempotencyKey: 'k-1' });
    now += 1;

    expect(entries.map((entry) => entry.kind)).toEqual([
      'session',
      'lease',
      'lease',
      'lease',
      'lease',
      'lease',
      'event',
    ]);
    expect(entries[1]).toMatchObject({
      kind: 'lease',
      commandId: 'command-1',
      lease: { leaseId: claim.leaseId, sealed: false, expiresAt: 1100 },
    });
    expect(entries[2]).toMatchObject({ lease: { sealed: true, expiresAt: null } });
    expect(entries[3]).toMatchObject({ lease: { sealed: true, result: { ok: true } } });
    expect(entries[5]).toMatchObject({ kind: 'lease', commandId: 'command-2', lease: null });
    expect(entries[6]).toMatchObject({
      kind: 'event',
      idempotencyKey: 'k-1',
      event: { eventId: first.eventId, sequence: 1 },
    });
  });

  it('restores an equivalent store from its own snapshot', async () => {
    let now = 1000;
    const source = new InMemoryAgentServerStore({ maxEventsPerSession: 2, now: () => now });
    await source.putSession(record('session-journal'));
    const claim = await source.claimCommand(tenantId, CommandId('sealed'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await source.sealCommand(tenantId, CommandId('sealed'), claim.leaseId);
    const keyed = await source.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    await source.appendEvent(tenantId, sessionId, event('two'));
    await source.appendEvent(tenantId, sessionId, event('three'));

    const snapshot = source.snapshot();
    expect(snapshot.map((entry) => entry.kind).sort()).toEqual(
      ['event', 'event', 'event_key', 'lease', 'session'].sort(),
    );

    const restored = new InMemoryAgentServerStore({ maxEventsPerSession: 2, now: () => now });
    restored.restore(snapshot);
    now += 10_000;

    await expect(restored.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await expect(restored.getEventStreamRange(tenantId, sessionId)).resolves.toEqual({
      firstSequence: 2,
      headSequence: 3,
    });
    await expect(restored.readEvents(tenantId, sessionId, { after: 1 })).resolves.toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    await expect(restored.readEvents(tenantId, sessionId, { after: 0 })).rejects.toThrow(/stale/i);
    const repeat = await restored.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    expect(repeat.eventId).toBe(keyed.eventId);
    await expect(restored.claimCommand(tenantId, CommandId('sealed'), 'fp', 100)).resolves.toEqual({
      status: 'in_progress',
      retryAfterMs: 1000,
    });
    const next = await restored.appendEvent(tenantId, sessionId, event('four'));
    expect(next.sequence).toBe(4);
  });

  it('refuses to restore into a store that already has state', async () => {
    const store = new InMemoryAgentServerStore();
    await store.putSession(record('session-journal'));
    expect(() => store.restore([])).toThrow(/empty store/i);
  });

  it('fails closed after the journal rejects a write', async () => {
    const failure = new Error('disk full');
    const store = new InMemoryAgentServerStore({
      journal: {
        async append() {
          throw failure;
        },
      },
    });
    await expect(store.putSession(record('session-journal'))).rejects.toBe(failure);
    await expect(store.healthCheck()).resolves.toMatchObject({ ready: false });
    await expect(store.appendEvent(tenantId, sessionId, event('one'))).rejects.toMatchObject({
      code: 'RUNTIME_STORE_JOURNAL_FAILED',
    });
    await expect(store.appendEvent(tenantId, sessionId, event('one'))).rejects.toBeInstanceOf(
      RuntimeStoreError,
    );
    await expect(store.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
  });
});
