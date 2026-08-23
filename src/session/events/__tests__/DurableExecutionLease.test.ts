import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandId, ExecutionLeaseId, SessionId, WorkerId } from '../../../types/branded.js';
import type { DurableEventStore } from '../DurableEventStore.js';
import { DurableExecutionLease } from '../DurableExecutionLease.js';
import {
  DurableExecutionLeaseError,
  type DurableExecutionLeaseStore,
} from '../DurableExecutionLeaseStore.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import { DurableSessionRecoveryCoordinator } from '../DurableSessionRecoveryCoordinator.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DurableEventType } from '../types.js';

const roots: string[] = [];

async function createStore(): Promise<JsonlDurableEventStore> {
  const root = await mkdtemp(join(tmpdir(), 'durable-execution-lease-'));
  roots.push(root);
  return new JsonlDurableEventStore(root);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableExecutionLease', () => {
  it('heartbeats the lease and releases it idempotently', async () => {
    const store = await createStore();
    const renew = vi.spyOn(store, 'renewExecutionLease');
    const release = vi.spyOn(store, 'releaseExecutionLease');
    const lease = await DurableExecutionLease.acquire(store, SessionId('heartbeat-session'), {
      ownerId: WorkerId('worker-a'),
      leaseId: ExecutionLeaseId('lease-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 20,
    });

    await vi.waitFor(() => expect(renew).toHaveBeenCalled(), { timeout: 1_000 });
    await lease.release();
    await lease.release();

    expect(release).toHaveBeenCalledTimes(1);
    expect(lease.signal.aborted).toBe(false);
  });

  it('does not reschedule heartbeat while release waits for an in-flight renewal', async () => {
    const store = await createStore();
    let resolveRenewal: (() => void) | undefined;
    const renew = vi.spyOn(store, 'renewExecutionLease').mockImplementationOnce(async (current) => {
      await new Promise<void>((resolve) => {
        resolveRenewal = resolve;
      });
      return current;
    });
    const release = vi.spyOn(store, 'releaseExecutionLease');
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('release-during-heartbeat-session'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 10,
      },
    );
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce(), { timeout: 1_000 });

    const releasePromise = lease.release();
    expect(release).not.toHaveBeenCalled();
    resolveRenewal?.();
    await releasePromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(renew).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('resumes heartbeats when lease release fails and remains retryable', async () => {
    const store = await createStore();
    const renew = vi.spyOn(store, 'renewExecutionLease');
    const release = vi.spyOn(store, 'releaseExecutionLease');
    release.mockRejectedValueOnce(new Error('temporary release failure'));
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('release-retry-heartbeat-session'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 20,
      },
    );

    await expect(lease.release()).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
    await vi.waitFor(() => expect(renew).toHaveBeenCalled(), { timeout: 1_000 });
    await expect(lease.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('stops renewing an abandoned lease while preserving explicit release', async () => {
    const store = await createStore();
    const renew = vi.spyOn(store, 'renewExecutionLease');
    const release = vi.spyOn(store, 'releaseExecutionLease');
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('abandoned-lease-session'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 20,
      },
    );

    lease.abandon(new Error('runtime cleanup failed'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(renew).not.toHaveBeenCalled();
    await expect(lease.assertActive()).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
    await expect(lease.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs short persistence work through the Store fencing boundary', async () => {
    const store = await createStore();
    const runFenced = vi.spyOn(store, 'withExecutionLease');
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('fenced-persistence-session'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    await expect(lease.runFenced(async () => 'persisted')).resolves.toBe(
      'persisted',
    );
    expect(runFenced).toHaveBeenCalledOnce();
    await lease.release();
  });

  it('aborts its signal when heartbeat ownership is lost', async () => {
    const store = await createStore();
    vi.spyOn(store, 'renewExecutionLease').mockRejectedValueOnce(
      new DurableExecutionLeaseError('DURABLE_EXECUTION_LEASE_LOST', 'lease was replaced'),
    );
    const lease = await DurableExecutionLease.acquire(store, SessionId('lost-session'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 20,
    });

    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true), {
      timeout: 1_000,
    });

    expect(lease.signal.reason).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
    await expect(lease.assertActive()).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('requires a lease-capable Store and a safe heartbeat interval', async () => {
    const store = await createStore();
    const unsupported: DurableEventStore = {
      append: (...args) => store.append(...args),
      read: (...args) => store.read(...args),
      getHeadSequence: (...args) => store.getHeadSequence(...args),
    };

    await expect(
      DurableExecutionLease.acquire(unsupported, SessionId('unsupported-session'), {
        ownerId: WorkerId('worker-a'),
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED',
    });
    await expect(
      DurableExecutionLease.acquire(store, SessionId('invalid-heartbeat-session'), {
        ownerId: WorkerId('worker-a'),
        ttlMs: 100,
        heartbeatIntervalMs: 51,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_INVALID',
    });
  });

  it('fences Journal commits, including replayed command IDs', async () => {
    const store = await createStore();
    const sessionId = SessionId('journal-fence-session');
    const lease = await DurableExecutionLease.acquire(store, sessionId, {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });
    const journal = await DurableSessionJournal.open(store, sessionId, {
      executionLease: lease,
    });
    const command = {
      commandId: CommandId('create-session'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' as const },
        },
      ],
    };
    await journal.commit(command);
    await lease.release();

    await expect(journal.commit(command)).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
  });

  it('rejects a lease bound to a different Store or Session', async () => {
    const firstStore = await createStore();
    const secondStore = await createStore();
    const lease = await DurableExecutionLease.acquire(firstStore, SessionId('lease-session'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });

    await expect(
      DurableSessionJournal.open(secondStore, SessionId('lease-session'), {
        executionLease: lease,
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      DurableSessionJournal.open(firstStore, SessionId('other-session'), { executionLease: lease }),
    ).rejects.toThrow(/does not belong/);
    await lease.release();
  });

  it('requires a lease when opening a previously fenced Journal or recovery coordinator', async () => {
    const store = await createStore();
    const sessionId = SessionId('sticky-journal-fence-session');
    await expect(DurableSessionJournal.open(store, sessionId)).resolves.toBeDefined();
    const firstLease = await DurableExecutionLease.acquire(store, sessionId, {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });
    await firstLease.release();

    await expect(DurableSessionJournal.open(store, sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
      sessionId,
    });
    await expect(DurableSessionRecoveryCoordinator.open(store, sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
      sessionId,
    });

    const successor = await DurableExecutionLease.acquire(store, sessionId, {
      ownerId: WorkerId('worker-b'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });
    await expect(
      DurableSessionRecoveryCoordinator.open(store, sessionId, {
        executionLease: successor,
      }),
    ).resolves.toBeDefined();
    await successor.release();
  });

  it('accepts structural lease Stores without requiring the JSONL adapter', async () => {
    const store = await createStore();
    const leaseStore: DurableExecutionLeaseStore = store;

    expect(leaseStore).toBe(store);
  });
});
