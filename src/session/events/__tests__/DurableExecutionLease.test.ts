import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandId,
  ExecutionLeaseId,
  FencingToken,
  SessionId,
  WorkerId,
} from '../../../types/branded.js';
import type { DurableEventStore } from '../DurableEventStore.js';
import { DurableExecutionLease } from '../DurableExecutionLease.js';
import {
  DurableExecutionLeaseError,
  DurableExecutionLeaseTimeoutError,
  type DurableExecutionLeaseStore,
  isDurableExecutionLeaseStore,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableExecutionLease', () => {
  it('bounds lease acquisition and aborts the Store signal', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    let storeSignal: AbortSignal | undefined;
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (_sessionId, options) => {
      storeSignal = options.signal;
      return await new Promise<never>(() => {});
    });
    const acquiring = DurableExecutionLease.acquire(store, SessionId('lease-acquire-timeout'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    });
    const rejection = expect(acquiring).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'acquire',
      timeoutMs: 25,
      sessionId: 'lease-acquire-timeout',
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(storeSignal?.aborted).toBe(true);
    expect(storeSignal?.reason).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });
  });

  it('reuses the generated lease identity after an uncertain acquisition', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const acquireNormally = store.acquireExecutionLease.bind(store);
    const firstCommitted = Promise.withResolvers<void>();
    const releaseFirstResponse = Promise.withResolvers<void>();
    const leaseIds: ExecutionLeaseId[] = [];
    let callCount = 0;
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (...args) => {
      callCount += 1;
      leaseIds.push(args[1].leaseId);
      const lease = await acquireNormally(...args);
      if (callCount === 1) {
        firstCommitted.resolve();
        await releaseFirstResponse.promise;
      }
      return lease;
    });
    const sessionId = SessionId('lease-acquire-retry');
    const acquireOptions = {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    } as const;
    const first = DurableExecutionLease.acquire(store, sessionId, acquireOptions);
    const firstRejection = expect(first).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'acquire',
    });
    await firstCommitted.promise;
    await vi.advanceTimersByTimeAsync(25);
    await firstRejection;

    const retry = await DurableExecutionLease.acquire(store, sessionId, acquireOptions);

    expect(leaseIds).toHaveLength(2);
    expect(leaseIds[1]).toBe(leaseIds[0]);
    releaseFirstResponse.resolve();
    await retry.release();
  });

  it('coordinates concurrent implicit acquisition identities', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const leaseIds: ExecutionLeaseId[] = [];
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (_sessionId, options) => {
      leaseIds.push(options.leaseId);
      return await new Promise<never>(() => {});
    });
    const sessionId = SessionId('lease-concurrent-acquire-timeout');
    const acquireOptions = {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    } as const;
    const outcomes = Promise.allSettled([
      DurableExecutionLease.acquire(store, sessionId, acquireOptions),
      DurableExecutionLease.acquire(store, sessionId, acquireOptions),
    ]);

    await vi.advanceTimersByTimeAsync(25);

    await expect(outcomes).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(leaseIds).toHaveLength(1);
  });

  it('rejects conflicting options for one in-flight acquisition identity', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(
      async () => await new Promise<never>(() => {}),
    );
    const sessionId = SessionId('lease-concurrent-options');
    const first = DurableExecutionLease.acquire(store, sessionId, {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    });
    const firstRejection = expect(first).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });

    await expect(
      DurableExecutionLease.acquire(store, sessionId, {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 5_000,
        storeTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_INVALID',
    });
    await vi.advanceTimersByTimeAsync(25);
    await firstRejection;
  });

  it('evicts an abandoned uncertain acquisition identity after its lease window', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const leaseIds: ExecutionLeaseId[] = [];
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (_sessionId, options) => {
      leaseIds.push(options.leaseId);
      return await new Promise<never>(() => {});
    });
    const sessionId = SessionId('lease-acquire-timeout-eviction');
    const acquireOptions = {
      ownerId: WorkerId('worker-a'),
      ttlMs: 100,
      heartbeatIntervalMs: 50,
      storeTimeoutMs: 25,
    } as const;
    const first = DurableExecutionLease.acquire(store, sessionId, acquireOptions);
    const firstRejection = expect(first).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(25);
    await firstRejection;

    await expect(
      DurableExecutionLease.acquire(store, sessionId, {
        ...acquireOptions,
        leaseId: ExecutionLeaseId('different-retry-identity'),
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_INVALID',
    });
    const shorterRetryOptions = {
      ...acquireOptions,
      ttlMs: 20,
      heartbeatIntervalMs: 10,
      storeTimeoutMs: 5,
    } as const;
    await expect(
      DurableExecutionLease.acquire(store, sessionId, shorterRetryOptions),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_INVALID',
    });

    await vi.advanceTimersByTimeAsync(125);
    const afterEviction = DurableExecutionLease.acquire(store, sessionId, acquireOptions);
    const afterEvictionRejection = expect(afterEviction).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(25);
    await afterEvictionRejection;

    expect(leaseIds).toHaveLength(2);
    expect(leaseIds[1]).not.toBe(leaseIds[0]);
  });

  it('adds the local lease identity to a Store-originated acquisition timeout', async () => {
    const store = await createStore();
    let leaseId: ExecutionLeaseId | undefined;
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (sessionId, options) => {
      leaseId = options.leaseId;
      throw new DurableExecutionLeaseTimeoutError('acquire', 10, { sessionId });
    });

    const error = await DurableExecutionLease.acquire(store, SessionId('lease-store-timeout'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'acquire',
      timeoutMs: 10,
      leaseId,
    });
  });

  it('fails closed at the Store-reported lease expiry', async () => {
    const store = await createStore();
    const acquireNormally = store.acquireExecutionLease.bind(store);
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (...args) => {
      const lease = await acquireNormally(...args);
      return {
        ...lease,
        expiresAt: new Date(Date.now() + 25).toISOString(),
      };
    });
    const lease = await DurableExecutionLease.acquire(store, SessionId('lease-local-expiry'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 1_000,
    });

    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true), {
      timeout: 1_000,
    });

    expect(lease.signal.reason).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
      sessionId: 'lease-local-expiry',
    });
    await lease.release();
  });

  it('bounds active Store calls by the current lease expiry', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const acquireNormally = store.acquireExecutionLease.bind(store);
    vi.spyOn(store, 'acquireExecutionLease').mockImplementation(async (...args) => {
      const lease = await acquireNormally(...args);
      return {
        ...lease,
        expiresAt: new Date(Date.now() + 100).toISOString(),
      };
    });
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('lease-current-expiry-timeout'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 5_000,
        storeTimeoutMs: 1_000,
      },
    );
    vi.spyOn(store, 'assertExecutionLease').mockImplementation(
      async () => await new Promise<never>(() => {}),
    );
    const assertion = lease.assertActive();
    const rejection = expect(assertion).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'assert',
      sessionId: 'lease-current-expiry-timeout',
    });

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(lease.signal.aborted).toBe(true);
    expect(
      (lease.signal.reason as DurableExecutionLeaseTimeoutError).timeoutMs,
    ).toBeLessThan(1_000);
    await lease.release();
  });

  it('adds active lease identity to a Store-originated timeout', async () => {
    const store = await createStore();
    const sessionId = SessionId('lease-active-store-timeout');
    const lease = await DurableExecutionLease.acquire(store, sessionId, {
      ownerId: WorkerId('worker-a'),
      leaseId: ExecutionLeaseId('lease-active'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 1_000,
    });
    vi.spyOn(store, 'assertExecutionLease').mockRejectedValueOnce(
      new DurableExecutionLeaseTimeoutError('assert', 10, { sessionId }),
    );

    const error = await lease.assertActive().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'assert',
      timeoutMs: 10,
      sessionId,
      leaseId: 'lease-active',
      fencingToken: 1,
    });
    expect(lease.signal.reason).toBe(error);
    await lease.release();
  });

  it('serializes lease timeout identity', () => {
    const error = new DurableExecutionLeaseTimeoutError('renew', 25, {
      sessionId: SessionId('lease-timeout-json'),
      leaseId: ExecutionLeaseId('lease-a'),
      fencingToken: FencingToken(7),
    });

    expect(error.toJSON()).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'renew',
      timeoutMs: 25,
      sessionId: 'lease-timeout-json',
      leaseId: 'lease-a',
      fencingToken: 7,
    });
  });

  it('fails closed when heartbeat renewal exceeds the Store deadline', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    let renewalSignal: AbortSignal | undefined;
    const lease = await DurableExecutionLease.acquire(store, SessionId('lease-renew-timeout'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 1_000,
      heartbeatIntervalMs: 100,
      storeTimeoutMs: 25,
    });
    vi.spyOn(store, 'renewExecutionLease').mockImplementation(async (_lease, _ttlMs, options) => {
      renewalSignal = options?.signal;
      return await new Promise<never>(() => {});
    });

    await vi.advanceTimersByTimeAsync(125);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'renew',
      timeoutMs: 25,
    });
    expect(renewalSignal?.aborted).toBe(true);
    await lease.release();
  });

  it('keeps a timed-out release retryable', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const releaseNormally = store.releaseExecutionLease.bind(store);
    let releaseSignal: AbortSignal | undefined;
    const lease = await DurableExecutionLease.acquire(store, SessionId('lease-release-timeout'), {
      ownerId: WorkerId('worker-a'),
      ttlMs: 10_000,
      heartbeatIntervalMs: 5_000,
      storeTimeoutMs: 25,
    });
    vi.spyOn(store, 'releaseExecutionLease')
      .mockImplementationOnce(async (_lease, options) => {
        releaseSignal = options?.signal;
        return await new Promise<never>(() => {});
      })
      .mockImplementation(releaseNormally);
    const firstRelease = lease.release();
    const rejection = expect(firstRelease).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'release',
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(releaseSignal?.aborted).toBe(true);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('fails closed when fenced persistence exceeds the Store deadline', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const lease = await DurableExecutionLease.acquire(
      store,
      SessionId('lease-fenced-store-timeout'),
      {
        ownerId: WorkerId('worker-a'),
        ttlMs: 10_000,
        heartbeatIntervalMs: 5_000,
        storeTimeoutMs: 25,
      },
    );
    let storeSignal: AbortSignal | undefined;
    let lateOperation: (() => Promise<unknown>) | undefined;
    let persistenceRan = false;
    vi.spyOn(store, 'withExecutionLease').mockImplementation(
      async (_lease, operation, options) => {
        storeSignal = options?.signal;
        lateOperation = operation;
        return await new Promise<never>(() => {});
      },
    );
    const persistence = lease.runFenced(async () => {
      persistenceRan = true;
      return 'unreachable';
    });
    const rejection = expect(persistence).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'with',
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(storeSignal?.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });
    if (!lateOperation) {
      throw new Error('Store did not capture the fenced operation');
    }
    await expect(lateOperation()).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
    });
    expect(persistenceRan).toBe(false);
    await lease.release();
  });

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
    const leaseStore = {
      append: (...args: Parameters<DurableEventStore['append']>) =>
        store.append(...args),
      read: (...args: Parameters<DurableEventStore['read']>) =>
        store.read(...args),
      getHeadSequence: (
        ...args: Parameters<DurableEventStore['getHeadSequence']>
      ) => store.getHeadSequence(...args),
      requiresExecutionLease: (
        ...args: Parameters<DurableExecutionLeaseStore['requiresExecutionLease']>
      ) => store.requiresExecutionLease(...args),
      acquireExecutionLease: (
        ...args: Parameters<DurableExecutionLeaseStore['acquireExecutionLease']>
      ) => store.acquireExecutionLease(...args),
      renewExecutionLease: (
        ...args: Parameters<DurableExecutionLeaseStore['renewExecutionLease']>
      ) => store.renewExecutionLease(...args),
      assertExecutionLease: (
        ...args: Parameters<DurableExecutionLeaseStore['assertExecutionLease']>
      ) => store.assertExecutionLease(...args),
      withExecutionLease: <T>(
        lease: Parameters<DurableExecutionLeaseStore['withExecutionLease']>[0],
        operation: () => Promise<T>,
      ) => store.withExecutionLease(lease, operation),
      releaseExecutionLease: (
        ...args: Parameters<DurableExecutionLeaseStore['releaseExecutionLease']>
      ) => store.releaseExecutionLease(...args),
    } satisfies DurableExecutionLeaseStore;

    expect(isDurableExecutionLeaseStore(leaseStore)).toBe(true);
    const lease = await DurableExecutionLease.acquire(
      leaseStore,
      SessionId('structural-session'),
      {
        ownerId: WorkerId('worker-a'),
      },
    );
    await lease.release();
  });
});
