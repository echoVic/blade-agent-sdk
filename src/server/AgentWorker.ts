import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { ExecutionLeaseId, type SessionId, type WorkerId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { getErrorCode, getErrorMessage } from '../utils/errorUtils.js';
import { EffectDispatcher, type RuntimeEffectHandler } from './EffectDispatcher.js';
import type { RuntimeStore } from './RuntimeStore.js';
import type {
  ActiveRuntimeSessionState,
  SessionRunner,
  SessionRunnerContext,
  SessionRunResult,
} from './SessionRunner.js';
import type { RuntimeSessionClaim, RuntimeSessionRoute } from './WorkerRuntime.js';

const DEFAULT_WORKER_TTL_MS = 15_000;
const DEFAULT_SESSION_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_RECOVERY_INTERVAL_MS = 5_000;

export type AgentWorkerStatus = 'idle' | 'running' | 'draining' | 'stopped' | 'failed';

export interface AgentWorkerMetrics {
  readonly startedAt?: string;
  readonly firstClaimLatencyMs?: number;
  readonly sessionClaims: number;
  readonly sessionsIdle: number;
  readonly sessionsCompleted: number;
  readonly sessionsSuspended: number;
  readonly sessionsFailed: number;
  readonly recoveryRuns: number;
  readonly recoveryDurationMs: number;
  readonly activeSessions: number;
  readonly elapsedMs: number;
  readonly completedSessionsPerSecond: number;
}

export interface AgentWorkerSnapshot {
  readonly workerId: WorkerId;
  readonly status: AgentWorkerStatus;
  readonly activeSessionIds: readonly SessionId[];
  readonly metrics: AgentWorkerMetrics;
  readonly effectMetrics?: ReturnType<EffectDispatcher['getMetrics']>;
  readonly failure?: JsonObject;
}

export interface AgentWorkerOptions {
  readonly store: RuntimeStore;
  readonly workerId: WorkerId;
  readonly capacity: number;
  readonly sessionRunner: SessionRunner;
  readonly executionHost?: SessionRunnerContext['executionHost'];
  readonly effectHandlers?: readonly RuntimeEffectHandler[];
  readonly tenantId?: string;
  readonly metadata?: JsonObject;
  readonly workerTtlMs?: number;
  readonly sessionLeaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly recoveryIntervalMs?: number;
  readonly effectClaimLimit?: number;
  readonly onSnapshot?: (snapshot: AgentWorkerSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

interface ActiveSession {
  claim: RuntimeSessionClaim;
  route: RuntimeSessionRoute;
  readonly controller: AbortController;
  readonly transitionMutex: Mutex;
  completion: Promise<void>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function failureData(error: unknown): JsonObject {
  const code = getErrorCode(error);
  return {
    message: getErrorMessage(error),
    ...(code ? { code } : {}),
  };
}

function activeSessionKey(route: RuntimeSessionRoute): string {
  return `${route.tenantId}\0${route.sessionId}`;
}

/**
 * Supervises durable Session claims and effect delivery for one worker.
 *
 * AgentWorker is intentionally transport-free. AgentServer remains the
 * control plane, while this class owns the execution-plane lifecycle.
 */
export class AgentWorker {
  private readonly workerTtlMs: number;
  private readonly sessionLeaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly effectDispatcher?: EffectDispatcher;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly controller = new AbortController();
  private status: AgentWorkerStatus = 'idle';
  private completion?: Promise<void>;
  private externalAbortCleanup?: () => void;
  private failure?: JsonObject;
  private startedAtMs?: number;
  private firstClaimLatencyMs?: number;
  private sessionClaims = 0;
  private sessionsIdle = 0;
  private sessionsCompleted = 0;
  private sessionsSuspended = 0;
  private sessionsFailed = 0;
  private recoveryRuns = 0;
  private recoveryDurationMs = 0;

  constructor(private readonly options: AgentWorkerOptions) {
    this.workerTtlMs = options.workerTtlMs ?? DEFAULT_WORKER_TTL_MS;
    this.sessionLeaseTtlMs = options.sessionLeaseTtlMs ?? DEFAULT_SESSION_LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    for (const [name, value] of [
      ['capacity', options.capacity],
      ['workerTtlMs', this.workerTtlMs],
      ['sessionLeaseTtlMs', this.sessionLeaseTtlMs],
      ['heartbeatIntervalMs', this.heartbeatIntervalMs],
      ['pollIntervalMs', this.pollIntervalMs],
      ['recoveryIntervalMs', this.recoveryIntervalMs],
    ] as const) {
      assertPositiveInteger(value, name);
    }
    if (this.heartbeatIntervalMs >= this.workerTtlMs) {
      throw new RangeError('heartbeatIntervalMs must be less than workerTtlMs');
    }
    if (this.heartbeatIntervalMs >= this.sessionLeaseTtlMs) {
      throw new RangeError('heartbeatIntervalMs must be less than sessionLeaseTtlMs');
    }
    if (options.effectHandlers) {
      this.effectDispatcher = new EffectDispatcher({
        store: options.store,
        workerId: options.workerId,
        handlers: options.effectHandlers,
        leaseTtlMs: this.sessionLeaseTtlMs,
        pollIntervalMs: this.pollIntervalMs,
        claimLimit: options.effectClaimLimit,
        tenantId: options.tenantId,
      });
    }
  }

  getSnapshot(): AgentWorkerSnapshot {
    const now = Date.now();
    const elapsedMs = this.startedAtMs === undefined ? 0 : Math.max(0, now - this.startedAtMs);
    const settled = this.sessionsIdle + this.sessionsCompleted;
    return {
      workerId: this.options.workerId,
      status: this.status,
      activeSessionIds: [...this.activeSessions.values()].map(({ route }) => route.sessionId),
      metrics: {
        ...(this.startedAtMs !== undefined
          ? { startedAt: new Date(this.startedAtMs).toISOString() }
          : {}),
        ...(this.firstClaimLatencyMs !== undefined
          ? { firstClaimLatencyMs: this.firstClaimLatencyMs }
          : {}),
        sessionClaims: this.sessionClaims,
        sessionsIdle: this.sessionsIdle,
        sessionsCompleted: this.sessionsCompleted,
        sessionsSuspended: this.sessionsSuspended,
        sessionsFailed: this.sessionsFailed,
        recoveryRuns: this.recoveryRuns,
        recoveryDurationMs: this.recoveryDurationMs,
        activeSessions: this.activeSessions.size,
        elapsedMs,
        completedSessionsPerSecond: elapsedMs === 0 ? 0 : settled / (elapsedMs / 1000),
      },
      ...(this.effectDispatcher ? { effectMetrics: this.effectDispatcher.getMetrics() } : {}),
      ...(this.failure ? { failure: structuredClone(this.failure) } : {}),
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(`AgentWorker cannot start from ${this.status}`);
    }
    signal?.throwIfAborted();
    await this.options.store.initialize();
    await this.options.store.registerWorker({
      workerId: this.options.workerId,
      capacity: this.options.capacity,
      ttlMs: this.workerTtlMs,
      metadata: this.options.metadata,
    });
    this.startedAtMs = Date.now();
    this.status = 'running';
    if (signal) {
      const onAbort = (): void => this.controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      this.externalAbortCleanup = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
      }
    }
    const loops = [
      this.sessionLoop(this.controller.signal),
      this.workerHeartbeatLoop(this.controller.signal),
      this.recoveryLoop(this.controller.signal),
      ...(this.effectDispatcher ? [this.effectLoop(this.controller.signal)] : []),
    ];
    this.completion = this.supervise(loops);
    void this.completion.catch(() => undefined);
    this.publishSnapshot();
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    await this.wait();
  }

  async wait(): Promise<void> {
    if (!this.completion) {
      throw new Error('AgentWorker has not been started');
    }
    await this.completion;
  }

  async drain(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'failed') {
      return;
    }
    if (this.status === 'idle') {
      throw new Error('AgentWorker has not been started');
    }
    if (this.status !== 'draining') {
      const previousStatus = this.status;
      this.status = 'draining';
      this.publishSnapshot();
      try {
        await this.options.store.drainWorker(this.options.workerId);
      } catch (error) {
        this.status = previousStatus;
        this.publishSnapshot();
        throw error;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.status === 'idle' || this.status === 'stopped') {
      return;
    }
    await this.drain();
    this.controller.abort(new Error('AgentWorker is shutting down'));
    await this.completion;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.activeSessions.values()].map(({ completion }) => completion));
  }

  private async supervise(loops: readonly Promise<void>[]): Promise<void> {
    try {
      await Promise.all(loops);
      await this.waitForIdle();
      this.status = 'stopped';
    } catch (error) {
      if (this.controller.signal.aborted) {
        await Promise.allSettled(loops);
        await Promise.allSettled(
          [...this.activeSessions.values()].map(({ completion }) => completion),
        );
        this.status = 'stopped';
        return;
      }
      this.failure = failureData(error);
      this.status = 'failed';
      this.controller.abort(error);
      await Promise.allSettled(loops);
      await Promise.allSettled(
        [...this.activeSessions.values()].map(({ completion }) => completion),
      );
      throw error;
    } finally {
      this.externalAbortCleanup?.();
      this.externalAbortCleanup = undefined;
      this.publishSnapshot();
    }
  }

  private async sessionLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.status === 'draining') {
        return;
      }
      let claimed = false;
      while (
        !signal.aborted &&
        this.status === 'running' &&
        this.activeSessions.size < this.options.capacity
      ) {
        const claim = await this.options.store.claimSession({
          ownerId: this.options.workerId,
          leaseId: ExecutionLeaseId(`session-lease-${nanoid()}`),
          ttlMs: this.sessionLeaseTtlMs,
          signal,
          ...(this.options.tenantId ? { tenantId: this.options.tenantId } : {}),
        });
        if (!claim) {
          break;
        }
        if (this.status !== 'running') {
          await this.options.store.handoffSession(
            claim.route.tenantId,
            claim.lease,
            {
              ...claim.route.metadata,
              handoffReason: 'worker_draining_before_start',
            },
          );
          break;
        }
        claimed = true;
        this.startSession(claim);
      }
      if (!claimed) {
        await abortableDelay(this.pollIntervalMs, signal).catch((error) => {
          if (!signal.aborted) {
            throw error;
          }
        });
      }
    }
    await this.waitForIdle();
  }

  private startSession(claim: RuntimeSessionClaim): void {
    const key = activeSessionKey(claim.route);
    if (this.activeSessions.has(key)) {
      throw new Error(`Session ${claim.route.sessionId} was claimed twice by one worker`);
    }
    this.sessionClaims += 1;
    if (this.firstClaimLatencyMs === undefined && this.startedAtMs !== undefined) {
      this.firstClaimLatencyMs = Date.now() - this.startedAtMs;
    }
    const controller = new AbortController();
    const active: ActiveSession = {
      claim,
      route: claim.route,
      controller,
      transitionMutex: new Mutex(),
      completion: Promise.resolve(),
    };
    this.activeSessions.set(key, active);
    active.completion = this.executeSession(claim, controller)
      .catch((error) => this.reportError(error))
      .finally(() => {
        this.activeSessions.delete(key);
        this.publishSnapshot();
      });
    this.publishSnapshot();
  }

  private async executeSession(
    claim: RuntimeSessionClaim,
    controller: AbortController,
  ): Promise<void> {
    const key = activeSessionKey(claim.route);
    const parentSignal = this.controller.signal;
    const onWorkerAbort = (): void => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onWorkerAbort, { once: true });
    const renewalController = new AbortController();
    let leaseFailure: unknown;
    const renewal = this.options.sessionRunner.managesLease
      ? Promise.resolve()
      : this.renewSessionLease(key, renewalController.signal).catch((error) => {
          leaseFailure = error;
          controller.abort(error);
        });
    try {
      const active = this.requireActiveSession(key);
      const context: SessionRunnerContext = {
        workerId: this.options.workerId,
        store: this.options.store,
        claim,
        signal: controller.signal,
        executionHost: this.options.executionHost,
        transition: (state, metadata) => this.transitionActiveSession(key, state, metadata),
      };
      const result = await this.options.sessionRunner.run(context);
      renewalController.abort();
      await renewal;
      if (leaseFailure !== undefined) {
        throw leaseFailure;
      }
      await this.finishSession(active, result);
    } catch (error) {
      const active = this.activeSessions.get(key);
      if (!active) {
        throw error;
      }
      if (
        active.route.state === 'idle'
        || active.route.state === 'completed'
        || active.route.state === 'failed'
        || active.route.state === 'suspended'
      ) {
        this.reportError(error);
        return;
      }
      if (controller.signal.aborted && leaseFailure === undefined) {
        await this.handoffActiveSession(active, {
          ...active.route.metadata,
          handoffReason: 'worker_shutdown',
        }).catch((handoffError) => {
          throw new AggregateError(
            [error, handoffError],
            `Session ${active.route.sessionId} failed during handoff`,
          );
        });
      } else {
        await this.failActiveSession(active, failureData(error)).catch((transitionError) => {
          throw new AggregateError(
            [error, transitionError],
            `Session ${active.route.sessionId} failed without a durable terminal state`,
          );
        });
      }
      this.reportError(error);
    } finally {
      controller.abort();
      renewalController.abort();
      await renewal;
      parentSignal.removeEventListener('abort', onWorkerAbort);
    }
  }

  private async finishSession(active: ActiveSession, result: SessionRunResult): Promise<void> {
    let transitionError: unknown;
    try {
      if (result.status === 'suspended') {
        await this.handoffActiveSession(active, result.metadata);
        return;
      }
      const target = result.status;
      active.route = await this.options.store.settleSession(
        active.route.tenantId,
        active.claim.lease,
        {
          state: target,
          ...(result.metadata ? { metadata: result.metadata } : {}),
          ...(result.status === 'failed' ? { failure: result.failure } : {}),
        },
      );
      if (target === 'idle') {
        this.sessionsIdle += 1;
      } else if (target === 'completed') {
        this.sessionsCompleted += 1;
      } else {
        this.sessionsFailed += 1;
      }
    } catch (error) {
      transitionError = error;
      throw error;
    } finally {
      if (result.finalize) {
        await result.finalize().catch((finalizeError) => {
          if (transitionError !== undefined) {
            throw new AggregateError(
              [transitionError, finalizeError],
              `Session ${active.route.sessionId} transition and finalization failed`,
            );
          }
          throw finalizeError;
        });
      }
    }
  }

  private async handoffActiveSession(active: ActiveSession, metadata?: JsonObject): Promise<void> {
    active.route = await this.options.store.handoffSession(
      active.route.tenantId,
      active.claim.lease,
      metadata,
    );
    this.sessionsSuspended += 1;
  }

  private async failActiveSession(active: ActiveSession, failure: JsonObject): Promise<void> {
    active.route = await this.options.store.transitionSession(
      active.route.tenantId,
      active.claim.lease,
      {
        expectedState: active.route.state,
        state: 'failed',
        failure,
      },
    );
    this.sessionsFailed += 1;
  }

  private transitionActiveSession(
    key: string,
    state: Extract<ActiveRuntimeSessionState, 'running' | 'waiting_approval'>,
    metadata?: JsonObject,
  ): Promise<RuntimeSessionRoute> {
    const active = this.requireActiveSession(key);
    return active.transitionMutex.runExclusive(async () => {
      const route = await this.options.store.transitionSession(
        active.route.tenantId,
        active.claim.lease,
        {
          expectedState: active.route.state,
          state,
          ...(metadata ? { metadata } : {}),
        },
      );
      active.route = route;
      this.publishSnapshot();
      return route;
    });
  }

  private async renewSessionLease(key: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.heartbeatIntervalMs, signal).catch((error) => {
        if (!signal.aborted) {
          throw error;
        }
      });
      if (signal.aborted) {
        return;
      }
      const active = this.requireActiveSession(key);
      active.claim = await this.options.store.renewSessionLease(
        active.route.tenantId,
        active.claim.lease,
        this.sessionLeaseTtlMs,
      );
      active.route = active.claim.route;
    }
  }

  private async workerHeartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.heartbeatIntervalMs, signal).catch((error) => {
        if (!signal.aborted) {
          throw error;
        }
      });
      if (signal.aborted) {
        return;
      }
      await this.options.store.heartbeatWorker(this.options.workerId, this.workerTtlMs);
    }
  }

  private async recoveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const startedAt = performance.now();
      await this.options.store.recoverExpiredWork();
      this.recoveryRuns += 1;
      this.recoveryDurationMs += performance.now() - startedAt;
      this.publishSnapshot();
      await abortableDelay(this.recoveryIntervalMs, signal).catch((error) => {
        if (!signal.aborted) {
          throw error;
        }
      });
    }
  }

  private async effectLoop(signal: AbortSignal): Promise<void> {
    if (!this.effectDispatcher) {
      return;
    }
    while (!signal.aborted) {
      if (this.status === 'draining') {
        return;
      }
      const count = await this.effectDispatcher.runOnce(signal);
      this.publishSnapshot();
      if (count === 0) {
        await abortableDelay(this.pollIntervalMs, signal).catch((error) => {
          if (!signal.aborted) {
            throw error;
          }
        });
      }
    }
  }

  private requireActiveSession(key: string): ActiveSession {
    const active = this.activeSessions.get(key);
    if (!active) {
      throw new Error(`Active Session ${key} is no longer owned by this worker`);
    }
    return active;
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting is observational and cannot change worker state.
    }
  }

  private publishSnapshot(): void {
    try {
      this.options.onSnapshot?.(this.getSnapshot());
    } catch {
      // Metrics are observational and cannot change worker state.
    }
  }
}
