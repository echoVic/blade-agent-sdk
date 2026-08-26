import { describe, expect, it, vi } from 'vitest';
import { ExecutionLeaseId, FencingToken, SessionId, WorkerId } from '../../types/identifiers.js';
import { AgentWorker } from '../AgentWorker.js';
import type { AgentWorkerTelemetry } from '../AgentWorkerTelemetry.js';
import type { RuntimeStore } from '../RuntimeStore.js';
import type { SessionRunner } from '../SessionRunner.js';
import type {
  RuntimeSessionClaim,
  RuntimeSessionRoute,
  RuntimeWorkerRecord,
} from '../WorkerRuntime.js';
import { WorkerRuntimeError } from '../WorkerRuntime.js';

const workerId = WorkerId('worker-1');
const sessionId = SessionId('session-1');
const now = new Date().toISOString();

function route(state: RuntimeSessionRoute['state']): RuntimeSessionRoute {
  return {
    tenantId: 'tenant-1',
    sessionId,
    state,
    priority: 0,
    attempt: 1,
    fencingToken: FencingToken(1),
    ...(state === 'provisioning' || state === 'running'
      ? {
          workerId,
          leaseId: ExecutionLeaseId('session-lease-1'),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      : {}),
    queuedAt: now,
    updatedAt: now,
    metadata: {},
  };
}

function claim(): RuntimeSessionClaim {
  return {
    route: route('provisioning'),
    lease: {
      sessionId,
      ownerId: workerId,
      leaseId: ExecutionLeaseId('session-lease-1'),
      fencingToken: FencingToken(1),
      acquiredAt: now,
      renewedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function workerRecord(status: RuntimeWorkerRecord['status']): RuntimeWorkerRecord {
  return {
    workerId,
    status,
    capacity: 1,
    activeSessions: 0,
    metadata: {},
    registeredAt: now,
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(status === 'draining' ? { drainingAt: now } : {}),
  };
}

function createStore(sessionClaim: RuntimeSessionClaim) {
  let nextClaim: RuntimeSessionClaim | null = sessionClaim;
  return {
    initialize: vi.fn(async () => undefined),
    registerWorker: vi.fn(async () => workerRecord('active')),
    heartbeatWorker: vi.fn(async () => workerRecord('active')),
    drainWorker: vi.fn(async () => workerRecord('draining')),
    recoverExpiredWork: vi.fn(async () => ({
      offlineWorkers: 0,
      suspendedSessions: 0,
      requeuedEffects: 0,
      uncertainEffects: 0,
    })),
    claimEffects: vi.fn(async () => []),
    claimSession: vi.fn(async () => {
      const result = nextClaim;
      nextClaim = null;
      return result;
    }),
    renewSessionLease: vi.fn(async () => sessionClaim),
    transitionSession: vi.fn(
      async (
        _tenantId: string,
        _lease: RuntimeSessionClaim['lease'],
        transition: {
          expectedState: RuntimeSessionRoute['state'];
          state: RuntimeSessionRoute['state'];
          metadata?: RuntimeSessionRoute['metadata'];
          failure?: RuntimeSessionRoute['failure'];
        },
      ) => ({
        ...sessionClaim.route,
        state: transition.state,
        metadata: transition.metadata ?? sessionClaim.route.metadata,
        failure: transition.failure,
      }),
    ),
    settleSession: vi.fn(
      async (
        _tenantId: string,
        _lease: RuntimeSessionClaim['lease'],
        settlement: {
          state: 'idle' | 'completed' | 'failed';
          metadata?: RuntimeSessionRoute['metadata'];
          failure?: RuntimeSessionRoute['failure'];
        },
      ) => ({
        ...sessionClaim.route,
        state: settlement.state,
        metadata: settlement.metadata ?? sessionClaim.route.metadata,
        failure: settlement.failure,
      }),
    ),
    handoffSession: vi.fn(
      async (
        _tenantId: string,
        _lease: RuntimeSessionClaim['lease'],
        metadata?: RuntimeSessionRoute['metadata'],
      ) => ({
        ...sessionClaim.route,
        state: 'suspended',
        metadata: metadata ?? sessionClaim.route.metadata,
      }),
    ),
  } as unknown as RuntimeStore;
}

describe('AgentWorker', () => {
  it('reports readiness and emits telemetry snapshots across its lifecycle', async () => {
    const sessionClaim = claim();
    const store = createStore(sessionClaim);
    const telemetry: AgentWorkerTelemetry = {
      recordSnapshot: vi.fn(),
      recordError: vi.fn(),
    };
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: {
        async run(context) {
          await context.transition('running');
          return { status: 'completed' };
        },
      },
      telemetry,
      heartbeatIntervalMs: 50,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 100,
    });

    expect(worker.getHealth()).toMatchObject({
      status: 'not_ready',
      live: true,
      ready: false,
      workerStatus: 'idle',
    });
    await worker.start();
    await vi.waitFor(() => {
      expect(worker.getSnapshot().metrics.sessionsCompleted).toBe(1);
    });
    expect(worker.getHealth()).toMatchObject({
      status: 'ready',
      live: true,
      ready: true,
      workerStatus: 'running',
    });
    await worker.shutdown();

    expect(worker.getHealth()).toMatchObject({
      status: 'not_ready',
      live: true,
      ready: false,
      workerStatus: 'stopped',
    });
    expect(telemetry.recordSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId,
        health: expect.objectContaining({ ready: true }),
      }),
    );
    expect(telemetry.recordError).not.toHaveBeenCalled();
  });

  it('refreshes telemetry after a successful heartbeat', async () => {
    const store = createStore(claim());
    vi.mocked(store.claimSession).mockResolvedValue(null);
    const telemetry: AgentWorkerTelemetry = {
      recordSnapshot: vi.fn(),
      recordError: vi.fn(),
    };
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: {
        async run() {
          return { status: 'completed' };
        },
      },
      telemetry,
      heartbeatIntervalMs: 100,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 100,
      recoveryIntervalMs: 10_000,
    });

    await worker.start();
    await vi.waitFor(() => {
      expect(store.recoverExpiredWork).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(telemetry.recordSnapshot).mockClear();
    await vi.waitFor(() => {
      expect(store.heartbeatWorker).toHaveBeenCalled();
      expect(telemetry.recordSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ health: expect.objectContaining({ ready: true }) }),
      );
    });
    await worker.shutdown();
  });

  it('claims a Session, runs it under a lease, and releases it into idle', async () => {
    const sessionClaim = claim();
    const store = createStore(sessionClaim);
    const finalize = vi.fn(async () => {
      expect(store.settleSession).toHaveBeenLastCalledWith(
        'tenant-1',
        sessionClaim.lease,
        {
          state: 'idle',
          metadata: { phase: 'finished' },
        },
      );
    });
    const runner: SessionRunner = {
      async run(context) {
        await context.transition('running', { phase: 'ready' });
        return {
          status: 'idle',
          metadata: { phase: 'finished' },
          finalize,
        };
      },
    };
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: runner,
      heartbeatIntervalMs: 50,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 100,
    });

    await worker.start();
    await vi.waitFor(() => {
      expect(worker.getSnapshot().metrics.sessionsIdle).toBe(1);
    });
    await worker.shutdown();

    expect(store.claimSession).toHaveBeenCalled();
    expect(store.transitionSession).toHaveBeenNthCalledWith(1, 'tenant-1', sessionClaim.lease, {
      expectedState: 'provisioning',
      state: 'running',
      metadata: { phase: 'ready' },
    });
    expect(store.settleSession).toHaveBeenCalledWith('tenant-1', sessionClaim.lease, {
      state: 'idle',
      metadata: { phase: 'finished' },
    });
    expect(worker.getSnapshot()).toMatchObject({
      status: 'stopped',
      metrics: {
        sessionClaims: 1,
        sessionsIdle: 1,
        activeSessions: 0,
      },
    });
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('hands off an active Session when the worker shuts down', async () => {
    const sessionClaim = claim();
    const store = createStore(sessionClaim);
    const runner: SessionRunner = {
      async run(context) {
        await context.transition('running');
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw context.signal.reason;
      },
    };
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: runner,
      heartbeatIntervalMs: 50,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 100,
    });

    await worker.start();
    await vi.waitFor(() => {
      expect(store.transitionSession).toHaveBeenCalledWith(
        'tenant-1',
        sessionClaim.lease,
        expect.objectContaining({ state: 'running' }),
      );
    });
    await worker.shutdown();

    expect(store.handoffSession).toHaveBeenCalledWith(
      'tenant-1',
      sessionClaim.lease,
      expect.objectContaining({ handoffReason: 'worker_shutdown' }),
    );
    expect(worker.getSnapshot()).toMatchObject({
      status: 'stopped',
      metrics: {
        sessionsSuspended: 1,
        activeSessions: 0,
      },
    });
  });

  it('reports transient background failures and continues supervising work', async () => {
    const sessionClaim = claim();
    const store = createStore(sessionClaim);
    const heartbeatError = new Error('heartbeat unavailable');
    const recoveryError = new Error('recovery unavailable');
    const effectError = new Error('effect claim unavailable');
    vi.mocked(store.heartbeatWorker)
      .mockRejectedValueOnce(heartbeatError)
      .mockResolvedValue(workerRecord('active'));
    vi.mocked(store.recoverExpiredWork)
      .mockRejectedValueOnce(recoveryError)
      .mockResolvedValue({
        offlineWorkers: 0,
        suspendedSessions: 0,
        requeuedEffects: 0,
        uncertainEffects: 0,
      });
    vi.mocked(store.claimEffects)
      .mockRejectedValueOnce(effectError)
      .mockResolvedValue([]);
    const onError = vi.fn();
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: {
        async run(context) {
          await context.transition('running');
          return { status: 'completed' };
        },
      },
      effectHandlers: [],
      heartbeatIntervalMs: 10,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 10,
      onError,
    });

    await worker.start();
    await vi.waitFor(() => {
      expect(
        vi.mocked(store.heartbeatWorker).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        vi.mocked(store.recoverExpiredWork).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        vi.mocked(store.claimEffects).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });

    expect(worker.getSnapshot().status).toBe('running');
    expect(onError).toHaveBeenCalledWith(heartbeatError);
    expect(onError).toHaveBeenCalledWith(recoveryError);
    expect(onError).toHaveBeenCalledWith(effectError);
    await worker.shutdown();
  });

  it('reports a fatal heartbeat failure through health and telemetry', async () => {
    const store = createStore(claim());
    vi.mocked(store.claimSession).mockResolvedValue(null);
    vi.mocked(store.heartbeatWorker).mockRejectedValue(
      new WorkerRuntimeError('WORKER_NOT_FOUND', 'worker lease was removed'),
    );
    const telemetry: AgentWorkerTelemetry = {
      recordSnapshot: vi.fn(),
      recordError: vi.fn(),
    };
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: {
        async run() {
          return { status: 'completed' };
        },
      },
      telemetry,
      heartbeatIntervalMs: 10,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 100,
    });

    await worker.start();
    await expect(worker.wait()).rejects.toMatchObject({
      code: 'WORKER_NOT_FOUND',
    });

    expect(worker.getHealth()).toMatchObject({
      status: 'failed',
      live: false,
      ready: false,
    });
    expect(telemetry.recordError).toHaveBeenCalledWith({
      workerId,
      workerStatus: 'failed',
      errorCode: 'WORKER_NOT_FOUND',
    });
  });

  it('treats an in-flight claim rejection during drain as normal shutdown', async () => {
    const sessionClaim = claim();
    const store = createStore(sessionClaim);
    let claimCalls = 0;
    let markSecondClaimStarted: () => void = () => undefined;
    const secondClaimStarted = new Promise<void>((resolve) => {
      markSecondClaimStarted = resolve;
    });
    let rejectSecondClaim: (error: unknown) => void = () => undefined;
    const blockedClaim = new Promise<null>((_resolve, reject) => {
      rejectSecondClaim = reject;
    });
    vi.mocked(store.claimSession).mockImplementation(async () => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return sessionClaim;
      }
      markSecondClaimStarted();
      return blockedClaim;
    });
    let finishDrain: () => void = () => undefined;
    vi.mocked(store.drainWorker).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDrain = () => resolve(workerRecord('draining'));
        }),
    );
    const worker = new AgentWorker({
      store,
      workerId,
      capacity: 1,
      sessionRunner: {
        async run(context) {
          await context.transition('running');
          return { status: 'completed' };
        },
      },
      heartbeatIntervalMs: 50,
      workerTtlMs: 500,
      sessionLeaseTtlMs: 500,
      pollIntervalMs: 10,
      recoveryIntervalMs: 100,
    });

    await worker.start();
    await secondClaimStarted;
    const shutdown = worker.shutdown();
    expect(worker.getSnapshot().status).toBe('draining');
    rejectSecondClaim(new Error('worker became unavailable while draining'));
    finishDrain();

    await expect(shutdown).resolves.toBeUndefined();
    expect(worker.getSnapshot().status).toBe('stopped');
  });
});
