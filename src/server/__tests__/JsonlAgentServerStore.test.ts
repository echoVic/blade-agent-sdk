import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/index.js';
import { CommandId, SessionId } from '../../types/identifiers.js';
import { JsonlAgentServerStore } from '../JsonlAgentServerStore.js';
import { RuntimeStoreError } from '../RuntimeStore.js';
import { describeAgentServerStoreContract } from './helpers/agentServerStoreContract.js';

const tenantId = 'tenant-jsonl';
const sessionId = SessionId('session-jsonl');

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jsonl-agent-server-store-'));
}

function record() {
  return {
    tenantId,
    createdBy: 'user-a',
    sessionId,
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

const sessionLine = `${JSON.stringify({ v: 1, kind: 'session', record: record() })}\n`;

describe('JsonlAgentServerStore contract', () => {
  describeAgentServerStoreContract(async (options = {}) => {
    const store = new JsonlAgentServerStore({ directory: await directory(), ...options });
    await store.initialize();
    return store;
  });
});

describe('JsonlAgentServerStore persistence', () => {
  it('replays sessions, events, idempotency keys and sealed leases after a restart', async () => {
    const dir = await directory();
    let now = 1000;
    const first = new JsonlAgentServerStore({
      directory: dir,
      maxEventsPerSession: 2,
      now: () => now,
    });
    await first.initialize();
    await first.putSession(record());
    const claim = await first.claimCommand(tenantId, CommandId('sealed'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await first.sealCommand(tenantId, CommandId('sealed'), claim.leaseId);
    const keyed = await first.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    await first.appendEvent(tenantId, sessionId, event('two'));
    await first.appendEvent(tenantId, sessionId, event('three'));
    await first.close();

    const second = new JsonlAgentServerStore({
      directory: dir,
      maxEventsPerSession: 2,
      now: () => now,
    });
    await second.initialize();
    now += 10_000;
    await expect(second.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await expect(second.getEventStreamRange(tenantId, sessionId)).resolves.toEqual({
      firstSequence: 2,
      headSequence: 3,
    });
    await expect(second.readEvents(tenantId, sessionId, { after: 1 })).resolves.toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    await expect(
      second.getEventByIdempotencyKey(tenantId, sessionId, 'terminal'),
    ).resolves.toMatchObject({ eventId: keyed.eventId });
    await expect(second.claimCommand(tenantId, CommandId('sealed'), 'fp', 100)).resolves.toEqual({
      status: 'in_progress',
      retryAfterMs: 1000,
    });
    const next = await second.appendEvent(tenantId, sessionId, event('four'));
    expect(next.sequence).toBe(4);
    await second.close();
  });

  it('compacts the journal on initialize', async () => {
    const dir = await directory();
    const first = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2 });
    await first.initialize();
    await first.putSession(record());
    for (const delta of ['one', 'two', 'three', 'four']) {
      await first.appendEvent(tenantId, sessionId, event(delta));
    }
    await first.close();
    const before = (await readFile(join(dir, 'server-store.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(before).toHaveLength(5);

    const second = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2 });
    await second.initialize();
    await second.close();
    const after = (await readFile(join(dir, 'server-store.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(after).toHaveLength(3);
    expect(after.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'session',
      'event',
      'event',
    ]);
  });

  it('tolerates a truncated last line and drops it on compaction', async () => {
    const dir = await directory();
    await writeFile(
      join(dir, 'server-store.jsonl'),
      `${sessionLine}{"v":1,"kind":"event","tenantId":"ten`,
    );
    const store = new JsonlAgentServerStore({ directory: dir });
    await store.initialize();
    await expect(store.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await store.close();
    expect(await readFile(join(dir, 'server-store.jsonl'), 'utf8')).toBe(sessionLine);
  });

  it('rejects a corrupt line with its line number', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'server-store.jsonl'), `${sessionLine}not json\n${sessionLine}`);
    const store = new JsonlAgentServerStore({ directory: dir });
    const failure = await store.initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeStoreError);
    expect(failure).toMatchObject({ code: 'RUNTIME_STORE_CORRUPT_JOURNAL' });
    expect((failure as Error).message).toContain('server-store.jsonl:2');
  });

  it('rejects an unknown journal version', async () => {
    const dir = await directory();
    await writeFile(
      join(dir, 'server-store.jsonl'),
      `${JSON.stringify({ v: 2, kind: 'session', record: record() })}\n`,
    );
    const store = new JsonlAgentServerStore({ directory: dir });
    await expect(store.initialize()).rejects.toMatchObject({
      code: 'RUNTIME_STORE_CORRUPT_JOURNAL',
    });
  });

  it('requires initialize() and rejects writes after close()', async () => {
    const dir = await directory();
    const store = new JsonlAgentServerStore({ directory: dir });
    await expect(store.putSession(record())).rejects.toThrow(/initialize/i);
    await store.initialize();
    await store.putSession(record());
    await store.close();
    await expect(store.putSession(record())).rejects.toThrow(/closed/i);
    await expect(store.healthCheck()).resolves.toMatchObject({ ready: false });
  });
});

describe('JsonlAgentServerStore locking', () => {
  it('refuses to initialize when a lock file already exists in the directory', async () => {
    const dir = await directory();
    const lockPath = join(dir, 'server-store.lock');
    await writeFile(lockPath, '');

    const store = new JsonlAgentServerStore({ directory: dir });
    const failure = await store.initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeStoreError);
    expect(failure).toMatchObject({ code: 'RUNTIME_STORE_LOCKED' });
    expect((failure as Error).message).toContain(lockPath);
    expect((failure as Error).message).toMatch(/another process/i);
  });

  it('releases its lock on close so a second store can start on the same directory', async () => {
    const dir = await directory();
    const lockPath = join(dir, 'server-store.lock');

    const first = new JsonlAgentServerStore({ directory: dir });
    await first.initialize();
    expect(existsSync(lockPath)).toBe(true);
    await first.close();
    expect(existsSync(lockPath)).toBe(false);

    const second = new JsonlAgentServerStore({ directory: dir });
    await expect(second.initialize()).resolves.toBeUndefined();
    expect(existsSync(lockPath)).toBe(true);
    await second.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when initialize() fails after acquiring it, so a retry sees the real error', async () => {
    const dir = await directory();
    const lockPath = join(dir, 'server-store.lock');
    // A corrupt journal fails initialize() only after the lock is acquired.
    await writeFile(join(dir, 'server-store.jsonl'), 'not json\n');

    const first = new JsonlAgentServerStore({ directory: dir });
    await expect(first.initialize()).rejects.toMatchObject({
      code: 'RUNTIME_STORE_CORRUPT_JOURNAL',
    });
    expect(existsSync(lockPath)).toBe(false);

    // A second attempt -- a retry, or a restart -- must see the same
    // underlying error rather than RUNTIME_STORE_LOCKED from a lock the
    // first, failed attempt left behind.
    const second = new JsonlAgentServerStore({ directory: dir });
    await expect(second.initialize()).rejects.toMatchObject({
      code: 'RUNTIME_STORE_CORRUPT_JOURNAL',
    });
    expect(existsSync(lockPath)).toBe(false);
  });
});
