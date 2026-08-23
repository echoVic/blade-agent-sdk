import { nanoid } from 'nanoid';
import { ExecutionLeaseId, type SessionId, type WorkerId } from '../../types/branded.js';
import type { DurableEventStore } from './DurableEventStore.js';
import {
  type DurableExecutionFence,
  DurableExecutionLeaseError,
  type DurableExecutionLease as DurableExecutionLeaseSnapshot,
  type DurableExecutionLeaseStore,
  executionFence,
  isDurableExecutionLeaseStore,
} from './DurableExecutionLeaseStore.js';

export const DEFAULT_EXECUTION_LEASE_TTL_MS = 30_000;
export const DEFAULT_EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

export interface DurableExecutionLeaseOptions {
  readonly ownerId: WorkerId;
  readonly leaseId?: ExecutionLeaseId;
  readonly ttlMs?: number;
  readonly heartbeatIntervalMs?: number;
}

type LeaseLostListener = (error: DurableExecutionLeaseError) => void;

/**
 * Process-local handle for a Store-backed execution lease.
 *
 * The Store remains authoritative for expiry and fencing. The heartbeat fails
 * closed: any renewal or validation failure aborts the signal exactly once.
 */
export class DurableExecutionLease {
  private current: DurableExecutionLeaseSnapshot;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<LeaseLostListener>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalPromise: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;
  private released = false;
  private loss: DurableExecutionLeaseError | null = null;

  private constructor(
    private readonly store: DurableExecutionLeaseStore,
    lease: DurableExecutionLeaseSnapshot,
    private readonly ttlMs: number,
    private readonly heartbeatIntervalMs: number,
  ) {
    this.current = lease;
    this.scheduleHeartbeat();
  }

  static async acquire(
    store: DurableEventStore,
    sessionId: SessionId,
    options: DurableExecutionLeaseOptions,
  ): Promise<DurableExecutionLease> {
    if (!isDurableExecutionLeaseStore(store)) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED',
        'The configured DurableEventStore does not support execution leases',
        { sessionId },
      );
    }
    const ttlMs = options.ttlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 2) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Execution lease ttlMs must be a safe integer of at least 2',
        { sessionId },
      );
    }
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1, Math.min(DEFAULT_EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS, Math.floor(ttlMs / 3)));
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs <= 0 ||
      heartbeatIntervalMs > Math.floor(ttlMs / 2)
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Execution lease heartbeatIntervalMs must be positive and at most half of ttlMs',
        { sessionId },
      );
    }
    const lease = await store.acquireExecutionLease(sessionId, {
      ownerId: options.ownerId,
      leaseId: options.leaseId ?? ExecutionLeaseId(nanoid()),
      ttlMs,
    });
    return new DurableExecutionLease(store, lease, ttlMs, heartbeatIntervalMs);
  }

  get snapshot(): DurableExecutionLeaseSnapshot {
    return structuredClone(this.current);
  }

  get fence(): DurableExecutionFence {
    return executionFence(this.current);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  belongsTo(store: DurableEventStore, sessionId: SessionId): boolean {
    return this.store === store && this.current.sessionId === sessionId;
  }

  onLost(listener: LeaseLostListener): () => void {
    this.listeners.add(listener);
    if (this.loss) {
      try {
        listener(this.loss);
      } catch {
        // A listener cannot restore lease ownership or block registration.
      }
    }
    return () => this.listeners.delete(listener);
  }

  async assertActive(): Promise<void> {
    this.throwIfUnavailable();
    try {
      await this.store.assertExecutionLease(this.current);
    } catch (cause) {
      const error = this.toLeaseLostError(cause);
      this.markLost(error);
      throw error;
    }
  }

  /** Serializes a short persistence operation against lease takeover. */
  async runFenced<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfUnavailable();
    try {
      return await this.store.withExecutionLease(this.current, operation);
    } catch (error) {
      this.observeStoreFailure(error);
      throw error;
    }
  }

  /** @internal Stops renewal without releasing Store ownership. */
  abandon(cause?: unknown): void {
    if (this.released || this.loss) {
      return;
    }
    this.markLost(
      new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${this.current.leaseId} was abandoned`,
        {
          sessionId: this.current.sessionId,
          leaseId: this.current.leaseId,
          fencingToken: this.current.fencingToken,
          cause,
        },
      ),
    );
  }

  observeStoreFailure(error: unknown): void {
    if (!this.isLeaseFailure(error)) {
      return;
    }
    this.markLost(
      error instanceof DurableExecutionLeaseError ? error : this.toLeaseLostError(error),
    );
  }

  async release(): Promise<void> {
    if (this.releasePromise) {
      return this.releasePromise;
    }
    if (this.released) {
      return;
    }
    const releasePromise = this.releaseInternal();
    this.releasePromise = releasePromise;
    try {
      await releasePromise;
    } catch (error) {
      if (this.releasePromise === releasePromise) {
        this.releasePromise = null;
      }
      throw error;
    }
  }

  private async releaseInternal(): Promise<void> {
    this.clearHeartbeat();
    if (this.renewalPromise) {
      await this.renewalPromise.catch(() => undefined);
      this.clearHeartbeat();
    }
    try {
      await this.store.releaseExecutionLease(this.current);
      this.released = true;
    } catch (cause) {
      if (
        this.isLeaseFailure(cause) &&
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        (cause.code === 'DURABLE_EXECUTION_LEASE_LOST' ||
          cause.code === 'DURABLE_EXECUTION_LEASE_CONFLICT')
      ) {
        this.released = true;
        return;
      }
      this.scheduleHeartbeat();
      throw this.toLeaseLostError(cause);
    }
  }

  private scheduleHeartbeat(): void {
    if (this.released || this.loss || this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.released || this.loss) {
        return;
      }
      this.renewalPromise = this.renew();
      void this.renewalPromise.finally(() => {
        this.renewalPromise = null;
        this.scheduleHeartbeat();
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async renew(): Promise<void> {
    try {
      this.current = await this.store.renewExecutionLease(this.current, this.ttlMs);
    } catch (cause) {
      this.markLost(this.toLeaseLostError(cause));
    }
  }

  private markLost(error: DurableExecutionLeaseError): void {
    if (this.loss || this.released) {
      return;
    }
    this.loss = error;
    this.clearHeartbeat();
    this.controller.abort(error);
    for (const listener of this.listeners) {
      try {
        listener(error);
      } catch {
        // A listener cannot restore lease ownership or block the loss signal.
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private throwIfUnavailable(): void {
    if (this.loss) {
      throw this.loss;
    }
    if (this.released) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${this.current.leaseId} was already released`,
        {
          sessionId: this.current.sessionId,
          leaseId: this.current.leaseId,
          fencingToken: this.current.fencingToken,
        },
      );
    }
  }

  private toLeaseLostError(cause: unknown): DurableExecutionLeaseError {
    return cause instanceof DurableExecutionLeaseError
      ? cause
      : new DurableExecutionLeaseError(
          'DURABLE_EXECUTION_LEASE_LOST',
          `Execution lease ${this.current.leaseId} could not be verified`,
          {
            sessionId: this.current.sessionId,
            leaseId: this.current.leaseId,
            fencingToken: this.current.fencingToken,
            cause,
          },
        );
  }

  private isLeaseFailure(error: unknown): boolean {
    return (
      error instanceof DurableExecutionLeaseError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('DURABLE_EXECUTION_LEASE_'))
    );
  }
}
