import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { FencingToken, type SessionId } from '../../types/identifiers.js';
import { syncParentDirectory, withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import type { DurableEventOperationOptions } from './DurableEventStore.js';
import {
  DURABLE_EXECUTION_LEASE_FORMAT,
  DURABLE_EXECUTION_LEASE_FORMAT_VERSION,
  type DurableExecutionFence,
  type DurableExecutionLease,
  type DurableExecutionLeaseAcquireOptions,
  DurableExecutionLeaseError,
  type DurableExecutionLeaseOperation,
  DurableExecutionLeaseTimeoutError,
  type PersistedDurableExecutionLeaseState,
  parsePersistedDurableExecutionLeaseState,
} from './DurableExecutionLeaseStore.js';
import { awaitDurableStoreOperation } from './DurableStoreOperation.js';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface JsonlExecutionLeaseStoreOptions {
  readonly rootDirectory: string;
  readonly clock: () => Date;
  readonly lockTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly lockPath: (sessionId: SessionId) => string;
}

export class JsonlExecutionLeaseStore {
  constructor(private readonly options: JsonlExecutionLeaseStoreOptions) {}

  filePath(sessionId: SessionId): string {
    return join(
      this.options.rootDirectory,
      `${Buffer.from(sessionId).toString('base64url')}.lease.json`,
    );
  }

  requires(sessionId: SessionId, options: DurableEventOperationOptions = {}): Promise<boolean> {
    return this.run(sessionId, 'requires', options.signal, (signal) =>
      this.locked(
        sessionId,
        'read',
        async () => (await this.load(sessionId, signal)) !== null,
        signal,
      ),
    );
  }

  acquire(
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease> {
    this.assertIdentity(sessionId, options);
    this.assertTtl(options.ttlMs);
    return this.run(sessionId, 'acquire', options.signal, (signal) =>
      this.locked(
        sessionId,
        'write',
        async () => {
          const current = await this.load(sessionId, signal);
          const now = this.options.clock();
          const active = current && this.isActive(current, now);
          if (
            active &&
            (current.leaseId !== options.leaseId || current.ownerId !== options.ownerId)
          ) {
            throw new DurableExecutionLeaseError(
              'DURABLE_EXECUTION_LEASE_CONFLICT',
              `Session ${sessionId} is leased by worker ${current.ownerId}`,
              {
                sessionId,
                leaseId: options.leaseId,
                fencingToken: current.fencingToken,
                activeLease: this.snapshot(current),
              },
            );
          }
          const reuse =
            active && current.leaseId === options.leaseId && current.ownerId === options.ownerId;
          const timestamp = now.toISOString();
          const next: PersistedDurableExecutionLeaseState = {
            format: DURABLE_EXECUTION_LEASE_FORMAT,
            version: DURABLE_EXECUTION_LEASE_FORMAT_VERSION,
            sessionId,
            fencingToken: reuse
              ? current.fencingToken
              : this.nextToken(sessionId, current?.fencingToken),
            leaseId: options.leaseId,
            ownerId: options.ownerId,
            acquiredAt: reuse ? current.acquiredAt : timestamp,
            renewedAt: timestamp,
            expiresAt: this.expiresAt(sessionId, now, options.ttlMs),
          };
          await this.write(next, signal);
          return this.snapshot(next);
        },
        signal,
      ),
    );
  }

  renew(
    lease: DurableExecutionLease,
    ttlMs: number,
    options: DurableEventOperationOptions = {},
  ): Promise<DurableExecutionLease> {
    this.assertIdentity(lease.sessionId, lease);
    this.assertTtl(ttlMs);
    return this.run(lease.sessionId, 'renew', options.signal, (signal) =>
      this.locked(
        lease.sessionId,
        'write',
        async () => {
          const current = await this.load(lease.sessionId, signal);
          const now = this.options.clock();
          this.assertMatches(lease, current, now);
          if (!current) throw this.lost(lease, 'no lease state exists');
          const next = {
            ...current,
            renewedAt: now.toISOString(),
            expiresAt: this.expiresAt(lease.sessionId, now, ttlMs),
          };
          await this.write(next, signal);
          return this.snapshot(next);
        },
        signal,
      ),
    );
  }

  async assert(
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertIdentity(lease.sessionId, lease);
    await this.run(lease.sessionId, 'assert', options.signal, (signal) =>
      this.locked(
        lease.sessionId,
        'read',
        async () =>
          this.assertMatches(lease, await this.load(lease.sessionId, signal), this.options.clock()),
        signal,
      ),
    );
  }

  withLease<T>(
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options: DurableEventOperationOptions = {},
  ): Promise<T> {
    this.assertIdentity(lease.sessionId, lease);
    return this.run(lease.sessionId, 'with', options.signal, (signal) =>
      this.locked(
        lease.sessionId,
        'write',
        async () => {
          this.assertMatches(lease, await this.load(lease.sessionId, signal), this.options.clock());
          signal.throwIfAborted();
          const result = await operation();
          signal.throwIfAborted();
          return result;
        },
        signal,
      ),
    );
  }

  async release(
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertIdentity(lease.sessionId, lease);
    await this.run(lease.sessionId, 'release', options.signal, (signal) =>
      this.locked(
        lease.sessionId,
        'write',
        async () => {
          const current = await this.load(lease.sessionId, signal);
          const now = this.options.clock();
          if (
            current?.releasedAt &&
            current.leaseId === lease.leaseId &&
            current.fencingToken === lease.fencingToken
          ) {
            return;
          }
          this.assertMatches(lease, current, now, false);
          if (!current) throw this.lost(lease, 'no lease state exists');
          await this.write({ ...current, releasedAt: now.toISOString() }, signal);
        },
        signal,
      ),
    );
  }

  async assertFence(
    sessionId: SessionId,
    fence: DurableExecutionFence | undefined,
    now: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.load(sessionId, signal);
    if (!current) {
      if (!fence) return;
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${fence.leaseId} does not exist for Session ${sessionId}`,
        { sessionId, leaseId: fence.leaseId, fencingToken: fence.fencingToken },
      );
    }
    if (!fence) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_REQUIRED',
        `Session ${sessionId} requires an execution lease`,
        {
          sessionId,
          ...(this.isActive(current, now) ? { activeLease: this.snapshot(current) } : {}),
        },
      );
    }
    if (
      !this.isActive(current, now) ||
      current.leaseId !== fence.leaseId ||
      current.fencingToken !== fence.fencingToken
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${fence.leaseId} is stale for Session ${sessionId}`,
        {
          sessionId,
          leaseId: fence.leaseId,
          fencingToken: fence.fencingToken,
          ...(this.isActive(current, now) ? { activeLease: this.snapshot(current) } : {}),
        },
      );
    }
  }

  private run<T>(
    sessionId: SessionId,
    operation: DurableExecutionLeaseOperation,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    return awaitDurableStoreOperation(
      {
        timeoutMs: this.options.operationTimeoutMs,
        signal,
        createTimeoutError: () =>
          new DurableExecutionLeaseTimeoutError(operation, this.options.operationTimeoutMs, {
            sessionId,
          }),
      },
      execute,
    );
  }

  private locked<T>(
    sessionId: SessionId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const storageError = (cause: unknown) => this.storageError(sessionId, operation, cause);
    return withAdvisoryFileLock(
      this.options.lockPath(sessionId),
      {
        timeoutMs: this.options.lockTimeoutMs,
        signal,
        errors: {
          prepare: storageError,
          initialize: storageError,
          acquire: storageError,
          timeout: () =>
            new DurableExecutionLeaseError(
              'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
              `Timed out acquiring the execution lease lock for Session ${sessionId}`,
              { sessionId },
            ),
          release: storageError,
        },
      },
      async () => {
        signal.throwIfAborted();
        const result = await callback();
        signal.throwIfAborted();
        return result;
      },
    );
  }

  private async load(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<PersistedDurableExecutionLeaseState | null> {
    try {
      const state = parsePersistedDurableExecutionLeaseState(
        JSON.parse(await readFile(this.filePath(sessionId), { encoding: 'utf8', signal })),
      );
      if (state.sessionId !== sessionId) {
        throw new Error(`Lease state belongs to Session ${state.sessionId}`);
      }
      return state;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      if (error instanceof DurableExecutionLeaseError) throw error;
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_CORRUPT',
        `Invalid execution lease state for Session ${sessionId}`,
        { sessionId, cause: error },
      );
    }
  }

  private async write(
    state: PersistedDurableExecutionLeaseState,
    signal: AbortSignal,
  ): Promise<void> {
    const filePath = this.filePath(state.sessionId);
    try {
      const validated = parsePersistedDurableExecutionLeaseState(state);
      signal.throwIfAborted();
      await mkdir(this.options.rootDirectory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      await writeFileAtomic(filePath, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        fsync: true,
        mode: 0o600,
      });
      signal.throwIfAborted();
      await syncParentDirectory(filePath);
      signal.throwIfAborted();
    } catch (cause) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
        `Failed to persist the execution lease for Session ${state.sessionId}`,
        { sessionId: state.sessionId, cause },
      );
    }
  }

  private assertMatches(
    lease: DurableExecutionLease,
    current: PersistedDurableExecutionLeaseState | null,
    now: Date,
    requireUnexpired = true,
  ): void {
    if (
      current &&
      !current.releasedAt &&
      current.leaseId === lease.leaseId &&
      current.ownerId === lease.ownerId &&
      current.fencingToken === lease.fencingToken &&
      (!requireUnexpired || this.isActive(current, now))
    ) {
      return;
    }
    throw this.lost(
      lease,
      current?.releasedAt
        ? 'it was released'
        : current && !this.isActive(current, now)
          ? 'it expired'
          : 'another owner holds the lease',
      current && this.isActive(current, now) ? this.snapshot(current) : undefined,
    );
  }

  private lost(
    lease: DurableExecutionLease,
    detail: string,
    activeLease?: DurableExecutionLease,
  ): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      `Execution lease ${lease.leaseId} for Session ${lease.sessionId} is no longer valid: ${detail}`,
      {
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        ...(activeLease ? { activeLease } : {}),
      },
    );
  }

  private storageError(
    sessionId: SessionId,
    operation: 'read' | 'write',
    cause: unknown,
  ): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      operation === 'write'
        ? 'DURABLE_EXECUTION_LEASE_WRITE_FAILED'
        : 'DURABLE_EXECUTION_LEASE_CORRUPT',
      `Failed to ${operation} the execution lease for Session ${sessionId}`,
      { sessionId, cause },
    );
  }

  private assertIdentity(
    sessionId: SessionId,
    lease: Pick<DurableExecutionLease, 'leaseId' | 'ownerId'> & { sessionId?: SessionId },
  ): void {
    if (
      sessionId.trim() === '' ||
      lease.leaseId.trim() === '' ||
      lease.ownerId.trim() === '' ||
      (lease.sessionId !== undefined && lease.sessionId !== sessionId)
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Invalid execution lease identity for Session ${sessionId}`,
        { sessionId, leaseId: lease.leaseId },
      );
    }
  }

  private assertTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}`,
      );
    }
  }

  private nextToken(sessionId: SessionId, current: FencingToken | undefined): FencingToken {
    const next = Number(current ?? 0) + 1;
    if (!Number.isSafeInteger(next)) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease fencing token is exhausted for Session ${sessionId}`,
        { sessionId },
      );
    }
    return FencingToken(next);
  }

  private expiresAt(sessionId: SessionId, now: Date, ttlMs: number): string {
    const expiresAt = new Date(now.getTime() + ttlMs);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease expiry is outside the supported date range for Session ${sessionId}`,
        { sessionId },
      );
    }
    return expiresAt.toISOString();
  }

  private isActive(state: PersistedDurableExecutionLeaseState, now: Date): boolean {
    return state.releasedAt === undefined && Date.parse(state.expiresAt) > now.getTime();
  }

  private snapshot(state: PersistedDurableExecutionLeaseState): DurableExecutionLease {
    const { sessionId, leaseId, ownerId, fencingToken, acquiredAt, renewedAt, expiresAt } = state;
    return { sessionId, leaseId, ownerId, fencingToken, acquiredAt, renewedAt, expiresAt };
  }
}
