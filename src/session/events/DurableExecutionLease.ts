import { nanoid } from 'nanoid';
import { ExecutionLeaseId, type SessionId, type WorkerId } from '../../types/identifiers.js';
import type { DurableEventStore } from './DurableEventStore.js';
import {
  type DurableExecutionFence,
  DurableExecutionLeaseError,
  type DurableExecutionLeaseOperation,
  type DurableExecutionLease as DurableExecutionLeaseSnapshot,
  type DurableExecutionLeaseStore,
  DurableExecutionLeaseTimeoutError,
  executionFence,
  isDurableExecutionLeaseStore,
  isExecutionLeaseFailure,
} from './DurableExecutionLeaseStore.js';
import {
  awaitDurableStoreOperation,
  MAX_DURABLE_STORE_TIMEOUT_MS,
  resolveDurableStoreTimeoutMs,
} from './DurableStoreOperation.js';

export const DEFAULT_EXECUTION_LEASE_TTL_MS = 30_000;
export const DEFAULT_EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

export interface DurableExecutionLeaseOptions {
  readonly ownerId: WorkerId;
  readonly leaseId?: ExecutionLeaseId;
  readonly ttlMs?: number;
  readonly heartbeatIntervalMs?: number;
  /** Maximum wall-clock duration of one Store call. Defaults to 15000ms. */
  readonly storeTimeoutMs?: number;
}

type LeaseLostListener = (error: DurableExecutionLeaseError) => void;

interface AcquisitionState {
  readonly leaseId: ExecutionLeaseId;
  attemptPromise: Promise<DurableExecutionLease> | null;
  readonly ttlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly storeTimeoutMs: number;
  uncertain: boolean;
  resolved: boolean;
  evictionDeadline: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

const ACQUISITION_STATES = new WeakMap<
  DurableExecutionLeaseStore,
  Map<SessionId, Map<WorkerId, AcquisitionState>>
>();

function getAcquisitionState(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
): AcquisitionState | undefined {
  return ACQUISITION_STATES.get(store)?.get(sessionId)?.get(ownerId);
}

function setAcquisitionState(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  state: AcquisitionState,
): void {
  let sessions = ACQUISITION_STATES.get(store);
  if (!sessions) {
    sessions = new Map();
    ACQUISITION_STATES.set(store, sessions);
  }
  let owners = sessions.get(sessionId);
  if (!owners) {
    owners = new Map();
    sessions.set(sessionId, owners);
  }
  owners.set(ownerId, state);
}

function clearAcquisitionState(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  state: AcquisitionState,
): void {
  const sessions = ACQUISITION_STATES.get(store);
  const owners = sessions?.get(sessionId);
  if (owners?.get(ownerId) !== state) {
    return;
  }
  if (state.evictionTimer) {
    clearTimeout(state.evictionTimer);
    state.evictionTimer = null;
  }
  owners.delete(ownerId);
  if (owners.size === 0) {
    sessions?.delete(sessionId);
  }
  if (sessions?.size === 0) {
    ACQUISITION_STATES.delete(store);
  }
}

function beginAcquisition(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  requestedLeaseId: ExecutionLeaseId | undefined,
  ttlMs: number,
  heartbeatIntervalMs: number,
  storeTimeoutMs: number,
): AcquisitionState {
  const existing = getAcquisitionState(store, sessionId, ownerId);
  if (existing) {
    if (requestedLeaseId !== undefined && requestedLeaseId !== existing.leaseId) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease retry identity differs for Session ${sessionId}`,
        {
          sessionId,
          leaseId: existing.leaseId,
        },
      );
    }
    if (
      existing.ttlMs !== ttlMs ||
      existing.heartbeatIntervalMs !== heartbeatIntervalMs ||
      existing.storeTimeoutMs !== storeTimeoutMs
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease retry options differ for Session ${sessionId}`,
        {
          sessionId,
          leaseId: existing.leaseId,
        },
      );
    }
    if (existing.evictionTimer) {
      clearTimeout(existing.evictionTimer);
      existing.evictionTimer = null;
    }
    return existing;
  }
  const state: AcquisitionState = {
    leaseId: requestedLeaseId ?? ExecutionLeaseId(nanoid()),
    attemptPromise: null,
    ttlMs,
    heartbeatIntervalMs,
    storeTimeoutMs,
    uncertain: false,
    resolved: false,
    evictionDeadline: 0,
    evictionTimer: null,
  };
  setAcquisitionState(store, sessionId, ownerId, state);
  return state;
}

function completeAcquisition(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  state: AcquisitionState,
): void {
  state.resolved = true;
  clearAcquisitionState(store, sessionId, ownerId, state);
}

function failAcquisition(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  state: AcquisitionState,
  outcomeUnknown: boolean,
  retentionMs: number,
): void {
  if (state.resolved || getAcquisitionState(store, sessionId, ownerId) !== state) {
    return;
  }
  state.uncertain ||= outcomeUnknown;
  if (!state.uncertain) {
    clearAcquisitionState(store, sessionId, ownerId, state);
    return;
  }
  if (state.evictionTimer) {
    clearTimeout(state.evictionTimer);
  }
  const now = performance.now();
  state.evictionDeadline = Math.max(
    state.evictionDeadline,
    now + Math.min(retentionMs, Number.MAX_SAFE_INTEGER - now),
  );
  scheduleAcquisitionEviction(store, sessionId, ownerId, state);
}

function scheduleAcquisitionEviction(
  store: DurableExecutionLeaseStore,
  sessionId: SessionId,
  ownerId: WorkerId,
  state: AcquisitionState,
): void {
  const remainingMs = state.evictionDeadline - performance.now();
  state.evictionTimer = setTimeout(
    () => {
      state.evictionTimer = null;
      if (state.resolved || getAcquisitionState(store, sessionId, ownerId) !== state) {
        return;
      }
      if (state.evictionDeadline > performance.now()) {
        scheduleAcquisitionEviction(store, sessionId, ownerId, state);
        return;
      }
      if (state.attemptPromise === null) {
        clearAcquisitionState(store, sessionId, ownerId, state);
      }
    },
    Math.min(Math.max(0, remainingMs), MAX_DURABLE_STORE_TIMEOUT_MS),
  );
  state.evictionTimer.unref?.();
}

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
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalPromise: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;
  private released = false;
  private loss: DurableExecutionLeaseError | null = null;

  private constructor(
    private readonly store: DurableExecutionLeaseStore,
    lease: DurableExecutionLeaseSnapshot,
    private readonly ttlMs: number,
    private readonly heartbeatIntervalMs: number,
    private readonly storeTimeoutMs: number,
    private localExpiresAt: number,
  ) {
    this.current = lease;
    this.scheduleExpiry();
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
    let configuredStoreTimeoutMs: number;
    try {
      configuredStoreTimeoutMs = resolveDurableStoreTimeoutMs(
        options.storeTimeoutMs,
        undefined,
        'Execution lease storeTimeoutMs',
      );
    } catch (cause) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Execution lease storeTimeoutMs is invalid',
        { sessionId, cause },
      );
    }
    const acquisitionState = beginAcquisition(
      store,
      sessionId,
      options.ownerId,
      options.leaseId,
      ttlMs,
      heartbeatIntervalMs,
      configuredStoreTimeoutMs,
    );
    if (acquisitionState.attemptPromise) {
      return acquisitionState.attemptPromise;
    }
    const { leaseId } = acquisitionState;
    const attempt = (async (): Promise<DurableExecutionLease> => {
      const acquisitionStartedAt = performance.now();
      try {
        const lease = await awaitDurableStoreOperation(
          {
            timeoutMs: configuredStoreTimeoutMs,
            createTimeoutError: () =>
              new DurableExecutionLeaseTimeoutError('acquire', configuredStoreTimeoutMs, {
                sessionId,
                leaseId,
              }),
          },
          (signal) =>
            store.acquireExecutionLease(sessionId, {
              ownerId: options.ownerId,
              leaseId,
              ttlMs,
              signal,
            }),
        );
        const handle = new DurableExecutionLease(
          store,
          lease,
          ttlMs,
          heartbeatIntervalMs,
          configuredStoreTimeoutMs,
          acquisitionStartedAt + DurableExecutionLease.resolveLeaseDurationMs(lease, ttlMs),
        );
        handle.throwIfUnavailable();
        completeAcquisition(store, sessionId, options.ownerId, acquisitionState);
        return handle;
      } catch (error) {
        let reportedError = error;
        if (
          isExecutionLeaseFailure(error) &&
          error.code === 'DURABLE_EXECUTION_LEASE_TIMEOUT' &&
          error.leaseId === undefined
        ) {
          reportedError = new DurableExecutionLeaseTimeoutError(
            'acquire',
            error instanceof DurableExecutionLeaseTimeoutError
              ? error.timeoutMs
              : configuredStoreTimeoutMs,
            {
              sessionId,
              leaseId,
              cause: error,
            },
          );
        }
        const outcomeUnknown =
          isExecutionLeaseFailure(reportedError) &&
          (reportedError.code === 'DURABLE_EXECUTION_LEASE_TIMEOUT' ||
            reportedError.code === 'DURABLE_EXECUTION_LEASE_WRITE_FAILED' ||
            reportedError.code === 'DURABLE_EXECUTION_LEASE_LOST');
        failAcquisition(
          store,
          sessionId,
          options.ownerId,
          acquisitionState,
          outcomeUnknown,
          ttlMs + configuredStoreTimeoutMs,
        );
        throw reportedError;
      }
    })();
    acquisitionState.attemptPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (acquisitionState.attemptPromise === attempt) {
        acquisitionState.attemptPromise = null;
      }
    }
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
      await this.runStoreOperation('assert', (signal) =>
        this.store.assertExecutionLease(this.current, { signal }),
      );
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
      return await this.runStoreOperation('with', (signal) =>
        this.store.withExecutionLease(
          this.current,
          async () => {
            signal.throwIfAborted();
            const result = await operation();
            signal.throwIfAborted();
            return result;
          },
          { signal },
        ),
      );
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
    if (!isExecutionLeaseFailure(error)) {
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
      await this.runStoreOperation('release', (signal) =>
        this.store.releaseExecutionLease(this.current, { signal }),
      );
      this.released = true;
      this.clearExpiry();
    } catch (cause) {
      if (
        isExecutionLeaseFailure(cause) &&
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        (cause.code === 'DURABLE_EXECUTION_LEASE_LOST' ||
          cause.code === 'DURABLE_EXECUTION_LEASE_CONFLICT')
      ) {
        this.released = true;
        this.clearExpiry();
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
      const renewalStartedAt = performance.now();
      const renewed = await this.runStoreOperation('renew', (signal) =>
        this.store.renewExecutionLease(this.current, this.ttlMs, { signal }),
      );
      this.current = renewed;
      this.localExpiresAt =
        renewalStartedAt + DurableExecutionLease.resolveLeaseDurationMs(renewed, this.ttlMs);
      this.scheduleExpiry();
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
    this.clearExpiry();
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

  private scheduleExpiry(): void {
    this.clearExpiry();
    if (this.released || this.loss) {
      return;
    }
    const remainingMs = this.localExpiresAt - performance.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      this.markLost(this.createExpiredError());
      return;
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null;
        if (this.released || this.loss) {
          return;
        }
        if (this.localExpiresAt > performance.now()) {
          this.scheduleExpiry();
          return;
        }
        this.markLost(this.createExpiredError());
      },
      Math.min(remainingMs, MAX_DURABLE_STORE_TIMEOUT_MS),
    );
    this.expiryTimer.unref?.();
  }

  private clearExpiry(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private createExpiredError(): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      `Execution lease ${this.current.leaseId} reached its local expiry boundary`,
      {
        sessionId: this.current.sessionId,
        leaseId: this.current.leaseId,
        fencingToken: this.current.fencingToken,
      },
    );
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

  private async runStoreOperation<T>(
    operation: Exclude<DurableExecutionLeaseOperation, 'requires' | 'acquire'>,
    execute: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    const timeoutMs =
      operation === 'release' ? this.storeTimeoutMs : this.resolveActiveStoreTimeoutMs();
    try {
      return await awaitDurableStoreOperation(
        {
          timeoutMs,
          ...(operation === 'release' ? {} : { signal: this.controller.signal }),
          createTimeoutError: () =>
            new DurableExecutionLeaseTimeoutError(operation, timeoutMs, {
              sessionId: this.current.sessionId,
              leaseId: this.current.leaseId,
              fencingToken: this.current.fencingToken,
            }),
        },
        execute,
      );
    } catch (error) {
      if (
        isExecutionLeaseFailure(error) &&
        error.code === 'DURABLE_EXECUTION_LEASE_TIMEOUT' &&
        (error.leaseId === undefined || error.fencingToken === undefined)
      ) {
        throw new DurableExecutionLeaseTimeoutError(
          operation,
          error instanceof DurableExecutionLeaseTimeoutError ? error.timeoutMs : timeoutMs,
          {
            sessionId: this.current.sessionId,
            leaseId: this.current.leaseId,
            fencingToken: this.current.fencingToken,
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private resolveActiveStoreTimeoutMs(): number {
    const remainingMs = Math.floor(this.localExpiresAt - performance.now() - 1);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      const error = this.createExpiredError();
      this.markLost(error);
      throw error;
    }
    return Math.min(this.storeTimeoutMs, remainingMs);
  }

  private static resolveLeaseDurationMs(
    lease: DurableExecutionLeaseSnapshot,
    ttlMs: number,
  ): number {
    const durationMs = Date.parse(lease.expiresAt) - Date.parse(lease.renewedAt);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return 0;
    }
    return Math.min(ttlMs, durationMs);
  }
}
