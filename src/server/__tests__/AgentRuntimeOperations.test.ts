import { describe, expect, it, vi } from 'vitest';
import { CommandId, SessionId, WorkerId } from '../../types/identifiers.js';
import { AgentRuntimeOperations } from '../AgentRuntimeOperations.js';
import type { AgentWorkerHealth } from '../AgentWorker.js';
import type { RuntimeEffectRecord, RuntimeStore } from '../RuntimeStore.js';
import type { RuntimeQueueMetrics } from '../WorkerRuntime.js';

const tenantId = 'tenant-1';
const now = '2026-08-26T00:00:00.000Z';

function queueMetrics(): RuntimeQueueMetrics {
  return {
    collectedAt: now,
    tenantId,
    sessions: {
      counts: {
        queued: 2,
        provisioning: 0,
        running: 1,
        waiting_approval: 0,
        suspended: 0,
        idle: 3,
        completed: 4,
        failed: 0,
      },
      claimable: 2,
      oldestClaimableAt: now,
      oldestClaimableAgeMs: 50,
    },
    effects: {
      counts: {
        pending: 1,
        claimed: 0,
        executing: 0,
        completed: 3,
        failed: 0,
        uncertain: 1,
      },
      claimable: 1,
      oldestClaimableAt: now,
      oldestClaimableAgeMs: 25,
    },
    workers: {
      counts: {
        active: 1,
        draining: 0,
        offline: 0,
      },
      capacity: 4,
      activeSessions: 1,
      availableCapacity: 3,
    },
  };
}

function workerHealth(): AgentWorkerHealth {
  return {
    workerId: WorkerId('worker-1'),
    status: 'ready',
    live: true,
    ready: true,
    workerStatus: 'running',
    checkedAt: now,
    activeSessions: 1,
    lastHeartbeatAt: now,
    heartbeatAgeMs: 0,
  };
}

function uncertainEffect(): RuntimeEffectRecord {
  return {
    tenantId,
    sessionId: SessionId('session-1'),
    commandId: CommandId('command-1'),
    effectId: 'effect-1',
    type: 'email.send',
    payload: { secret: 'must-not-leak' },
    idempotencyKey: 'effect-key',
    executionMode: 'at_most_once',
    status: 'uncertain',
    attempts: 1,
    createdAt: now,
    completedAt: now,
    error: { reason: 'worker_lost' },
  };
}

function createOperations(options: { authorized?: boolean } = {}) {
  const effect = uncertainEffect();
  const store = {
    healthCheck: vi.fn(async () => ({
      ready: true,
      details: { backend: 'sensitive-backend' },
    })),
    getQueueMetrics: vi.fn(async () => queueMetrics()),
    listEffects: vi.fn(async () => [effect]),
    reconcileEffect: vi.fn(async (_tenantId, _effectId, outcome) => ({
      ...effect,
      status: outcome.status,
      ...(outcome.status === 'completed' ? { result: outcome.result } : { error: outcome.error }),
    })),
  } as unknown as RuntimeStore;
  const authorize = vi.fn(async () =>
    options.authorized === false ? null : { tenantId, subject: 'operator-1' },
  );
  const operations = new AgentRuntimeOperations({
    store,
    authorize,
    workers: [
      {
        getHealth: workerHealth,
      },
    ],
  });
  return { authorize, effect, operations, store };
}

describe('AgentRuntimeOperations', () => {
  it('reports store and worker readiness without authentication', async () => {
    const { authorize, operations } = createOperations();
    const response = await operations.handle(new Request('http://localhost/v1/runtime/readyz'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ready',
      live: true,
      ready: true,
      store: { ready: true },
      workers: {
        total: 1,
        live: 1,
        ready: 1,
        failed: 0,
      },
    });
    expect(JSON.stringify(body)).not.toContain('worker-1');
    expect(JSON.stringify(body)).not.toContain('sensitive-backend');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('protects metrics and scopes the queue snapshot to the operator tenant', async () => {
    const unauthorized = createOperations({ authorized: false });
    await expect(
      unauthorized.operations.handle(new Request('http://localhost/v1/runtime/metrics')),
    ).resolves.toMatchObject({ status: 401 });

    const { authorize, operations, store } = createOperations();
    const response = await operations.handle(new Request('http://localhost/v1/runtime/metrics'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      queue: {
        tenantId,
        sessions: { claimable: 2 },
        effects: { claimable: 1 },
        workers: { availableCapacity: 3 },
      },
    });
    expect(body).not.toHaveProperty('workers');
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), 'metrics.read');
    expect(store.getQueueMetrics).toHaveBeenCalledWith(tenantId);
  });

  it('fails closed when authorization throws', async () => {
    const { store } = createOperations();
    const authorize = vi.fn(async () => {
      throw new Error('identity provider unavailable');
    });
    const guarded = new AgentRuntimeOperations({
      store,
      authorize,
    });

    const response = await guarded.handle(new Request('http://localhost/v1/runtime/metrics'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Runtime operations authorization failed',
    });
  });

  it('returns 501 when a compatible Store has no queue metrics capability', async () => {
    const { operations, store } = createOperations();
    Reflect.deleteProperty(store, 'getQueueMetrics');

    const response = await operations.handle(new Request('http://localhost/v1/runtime/metrics'));

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'Runtime operations request failed',
    });
  });

  it('lists redacted uncertain effects and reconciles an explicit outcome', async () => {
    const { operations, store } = createOperations();
    const listResponse = await operations.handle(
      new Request('http://localhost/v1/runtime/effects/uncertain?limit=10'),
    );
    const listed = (await listResponse.json()) as {
      effects: Record<string, unknown>[];
    };

    expect(listResponse.status).toBe(200);
    expect(listed.effects[0]).toMatchObject({
      effectId: 'effect-1',
      status: 'uncertain',
      error: { reason: 'worker_lost' },
    });
    expect(listed.effects[0]).not.toHaveProperty('payload');
    expect(listed.effects[0]).not.toHaveProperty('idempotencyKey');

    const reconcileResponse = await operations.handle(
      new Request('http://localhost/v1/runtime/effects/effect-1/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          result: { receiptId: 'receipt-1' },
        }),
      }),
    );

    expect(reconcileResponse.status).toBe(200);
    await expect(reconcileResponse.json()).resolves.toMatchObject({
      effect: {
        effectId: 'effect-1',
        status: 'completed',
      },
    });
    expect(store.reconcileEffect).toHaveBeenCalledWith(tenantId, 'effect-1', {
      status: 'completed',
      result: { receiptId: 'receipt-1' },
    });
  });
});
