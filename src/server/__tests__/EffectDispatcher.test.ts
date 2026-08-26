import { describe, expect, it, vi } from 'vitest';
import {
  CommandId,
  ExecutionLeaseId,
  FencingToken,
  SessionId,
  WorkerId,
} from '../../types/identifiers.js';
import {
  EffectDispatcher,
  RetryableRuntimeEffectError,
  UncertainRuntimeEffectError,
} from '../EffectDispatcher.js';
import type { RuntimeEffectClaim, WorkerRuntimeStore } from '../WorkerRuntime.js';

function effect(
  executionMode: RuntimeEffectClaim['executionMode'] = 'idempotent',
): RuntimeEffectClaim {
  return {
    tenantId: 'tenant-1',
    sessionId: SessionId('session-1'),
    commandId: CommandId('command-1'),
    effectId: 'effect-1',
    type: 'notify',
    payload: { message: 'hello' },
    idempotencyKey: 'notify:1',
    executionMode,
    status: 'claimed',
    attempts: 0,
    createdAt: new Date().toISOString(),
    workerId: WorkerId('worker-1'),
    leaseId: ExecutionLeaseId('effect-lease-1'),
    fencingToken: FencingToken(1),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function createStore(claim: RuntimeEffectClaim) {
  let claims = [claim];
  return {
    claimEffects: vi.fn(async () => {
      const result = claims;
      claims = [];
      return result;
    }),
    startEffect: vi.fn(async () => ({ ...claim, status: 'executing' })),
    renewEffectLease: vi.fn(async () => ({ ...claim, status: 'executing' })),
    completeEffect: vi.fn(async (_lease, result) => ({
      ...claim,
      status: 'completed',
      result,
    })),
    failEffect: vi.fn(async (_lease, error, options) => ({
      ...claim,
      status: options?.retryAt ? 'pending' : 'failed',
      error,
    })),
    markEffectUncertain: vi.fn(async (_lease, error) => ({
      ...claim,
      status: 'uncertain',
      error,
    })),
  } as unknown as WorkerRuntimeStore;
}

describe('EffectDispatcher', () => {
  it('starts a durable effect before invoking its handler and commits the result', async () => {
    const claim = effect();
    const store = createStore(claim);
    const execute = vi.fn(async () => ({ delivered: true }));
    const dispatcher = new EffectDispatcher({
      store,
      workerId: WorkerId('worker-1'),
      handlers: [{ type: 'notify', execute }],
    });

    await expect(dispatcher.runOnce()).resolves.toBe(1);

    expect(store.startEffect).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      effect: claim,
      signal: expect.any(AbortSignal),
    });
    expect(store.completeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-1' }),
      { delivered: true },
    );
    expect(dispatcher.getMetrics()).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
      retried: 0,
      uncertain: 0,
    });
  });

  it('requeues only explicitly retryable idempotent effects', async () => {
    const claim = effect('idempotent');
    const store = createStore(claim);
    const dispatcher = new EffectDispatcher({
      store,
      workerId: WorkerId('worker-1'),
      retryDelayMs: 50,
      maxRetryDelayMs: 50,
      handlers: [
        {
          type: 'notify',
          async execute() {
            throw new RetryableRuntimeEffectError('temporary');
          },
        },
      ],
    });

    await dispatcher.runOnce();

    expect(store.failEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-1' }),
      expect.objectContaining({ message: 'temporary' }),
      expect.objectContaining({ retryAt: expect.any(String) }),
    );
    expect(dispatcher.getMetrics().retried).toBe(1);
  });

  it('clamps handler retry delays to the configured bounds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    try {
      const claim = effect('idempotent');
      const store = createStore(claim);
      const dispatcher = new EffectDispatcher({
        store,
        workerId: WorkerId('worker-1'),
        retryDelayMs: 50,
        maxRetryDelayMs: 500,
        handlers: [
          {
            type: 'notify',
            async execute() {
              throw new RetryableRuntimeEffectError('temporary', 0.5);
            },
          },
        ],
      });

      await dispatcher.runOnce();

      expect(store.failEffect).toHaveBeenCalledWith(
        expect.objectContaining({ effectId: 'effect-1' }),
        expect.objectContaining({ message: 'temporary' }),
        { retryAt: '2026-08-26T00:00:00.050Z' },
      );

      const upperStore = createStore(claim);
      const upperDispatcher = new EffectDispatcher({
        store: upperStore,
        workerId: WorkerId('worker-1'),
        retryDelayMs: 50,
        maxRetryDelayMs: 500,
        handlers: [
          {
            type: 'notify',
            async execute() {
              throw new RetryableRuntimeEffectError('temporary', 5_000);
            },
          },
        ],
      });

      await upperDispatcher.runOnce();

      expect(upperStore.failEffect).toHaveBeenCalledWith(
        expect.objectContaining({ effectId: 'effect-1' }),
        expect.objectContaining({ message: 'temporary' }),
        { retryAt: '2026-08-26T00:00:00.500Z' },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks an at-most-once effect uncertain when its outcome cannot be proven', async () => {
    const claim = effect('at_most_once');
    const store = createStore(claim);
    const dispatcher = new EffectDispatcher({
      store,
      workerId: WorkerId('worker-1'),
      handlers: [
        {
          type: 'notify',
          async execute() {
            throw new UncertainRuntimeEffectError('remote accepted without receipt');
          },
        },
      ],
    });

    await dispatcher.runOnce();

    expect(store.markEffectUncertain).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-1' }),
      expect.objectContaining({ message: 'remote accepted without receipt' }),
    );
    expect(store.failEffect).not.toHaveBeenCalled();
    expect(dispatcher.getMetrics().uncertain).toBe(1);
  });

  it('marks an at-most-once effect uncertain when completion persistence fails', async () => {
    const claim = effect('at_most_once');
    const store = createStore(claim);
    vi.mocked(store.completeEffect).mockRejectedValueOnce(
      new Error('database connection lost'),
    );
    const dispatcher = new EffectDispatcher({
      store,
      workerId: WorkerId('worker-1'),
      handlers: [{
        type: 'notify',
        async execute() {
          return { delivered: true };
        },
      }],
    });

    await dispatcher.runOnce();

    expect(store.markEffectUncertain).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-1' }),
      expect.objectContaining({
        message: 'Effect handler completed but its durable completion is unknown',
      }),
    );
  });

  it('isolates one effect persistence failure from the rest of the batch', async () => {
    const first = effect();
    const second = {
      ...effect(),
      effectId: 'effect-2',
      idempotencyKey: 'notify:2',
    };
    const store = createStore(first);
    vi.mocked(store.claimEffects).mockResolvedValueOnce([first, second]);
    vi.mocked(store.startEffect).mockImplementation(async (lease) => {
      if (lease.effectId === first.effectId) {
        throw new Error('database connection lost');
      }
      return { ...second, status: 'executing' };
    });
    const execute = vi.fn(async () => ({ delivered: true }));
    const onError = vi.fn();
    const dispatcher = new EffectDispatcher({
      store,
      workerId: WorkerId('worker-1'),
      handlers: [{ type: 'notify', execute }],
      onError,
    });

    await expect(dispatcher.runOnce()).resolves.toBe(2);

    expect(execute).toHaveBeenCalledOnce();
    expect(store.completeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-2' }),
      { delivered: true },
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'database connection lost' }),
      first,
    );
  });
});
