import { nanoid } from 'nanoid';
import { Buffer } from 'node:buffer';
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { EventId, EventSequence, FencingToken, type SessionId } from '../../types/branded.js';
import { syncParentDirectory, withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import {
  type DurableEventOperationOptions,
  DurableEventSequenceConflictError,
  DurableEventStoreError,
  type DurableEventStoreOperation,
  DurableEventStoreTimeoutError,
} from './DurableEventStore.js';
import {
  DURABLE_EXECUTION_LEASE_FORMAT,
  DURABLE_EXECUTION_LEASE_FORMAT_VERSION,
  type DurableExecutionFence,
  type DurableExecutionLease,
  type DurableExecutionLeaseAcquireOptions,
  DurableExecutionLeaseError,
  type DurableExecutionLeaseOperation,
  type DurableExecutionLeaseStore,
  DurableExecutionLeaseTimeoutError,
  type PersistedDurableExecutionLeaseState,
  parsePersistedDurableExecutionLeaseState,
} from './DurableExecutionLeaseStore.js';
import {
  DEFAULT_DURABLE_STORE_TIMEOUT_MS,
  MAX_DURABLE_STORE_TIMEOUT_MS,
  awaitDurableStoreOperation,
  resolveDurableStoreTimeoutMs,
} from './DurableStoreOperation.js';
import {
  DURABLE_EVENT_LOG_FORMAT,
  type PersistedDurableEventBatch,
  parseDurableEventDraft,
  parsePersistedDurableEventBatch,
} from './schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventAppendOptions,
  type DurableEventAppendResult,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventPage,
  type DurableEventReadOptions,
  type DurableEventSchemaVersion,
} from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const EVENT_DIRECTORY = 'durable-events';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const MAX_EXECUTION_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface JsonlDurableEventStoreOptions {
  clock?: () => Date;
  eventIdFactory?: () => EventId;
  /** Maximum total time to wait for local or cross-process Session lock ownership. */
  lockTimeoutMs?: number;
  /** Maximum wall-clock duration of one Store call. Defaults to at least 15000ms. */
  operationTimeoutMs?: number;
}

interface LoadedLog {
  events: DurableEventEnvelope[];
  exists: boolean;
  committedBytes: number;
  totalBytes: number;
}

/**
 * Durable local adapter with process-local serialization and OS advisory locks
 * across Node.js processes sharing the same storage directory.
 * Distributed executors must still provide a Store with external CAS/fencing.
 */
export class JsonlDurableEventStore implements DurableExecutionLeaseStore {
  private readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly eventIdFactory: () => EventId;
  private readonly lockTimeoutMs: number;
  private readonly operationTimeoutMs: number;

  constructor(storageRoot: string, options: JsonlDurableEventStoreOptions = {}) {
    if (storageRoot.trim() === '') {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_OPTIONS',
        'Durable event storage root must not be empty',
      );
    }
    this.rootDirectory = resolve(storageRoot, EVENT_DIRECTORY);
    this.clock = options.clock ?? (() => new Date());
    this.eventIdFactory = options.eventIdFactory ?? (() => EventId(nanoid()));
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.lockTimeoutMs) ||
      this.lockTimeoutMs < 0 ||
      this.lockTimeoutMs > MAX_DURABLE_STORE_TIMEOUT_MS
    ) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_OPTIONS',
        'Durable event lockTimeoutMs must be a non-negative safe integer',
      );
    }
    const defaultOperationTimeoutMs = Math.min(
      MAX_DURABLE_STORE_TIMEOUT_MS,
      this.lockTimeoutMs + DEFAULT_DURABLE_STORE_TIMEOUT_MS,
    );
    try {
      this.operationTimeoutMs = resolveDurableStoreTimeoutMs(
        options.operationTimeoutMs,
        defaultOperationTimeoutMs,
        'Durable event operationTimeoutMs',
      );
    } catch (cause) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_OPTIONS',
        'Durable event operationTimeoutMs is invalid',
        { cause },
      );
    }
    if (this.operationTimeoutMs < this.lockTimeoutMs) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_OPTIONS',
        'Durable event operationTimeoutMs must be greater than or equal to lockTimeoutMs',
      );
    }
  }

  async append(
    sessionId: SessionId,
    drafts: readonly DurableEventDraft[],
    options: DurableEventAppendOptions = {},
  ): Promise<DurableEventAppendResult> {
    if (drafts.length === 0) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_APPEND',
        'A durable event append requires at least one event',
      );
    }

    const parsedDrafts = drafts.map((draft, index) => {
      try {
        return parseDurableEventDraft(draft);
      } catch (error) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_INVALID_APPEND',
          `Invalid durable event draft at index ${index}`,
          { cause: error },
        );
      }
    });

    return this.runEventOperation(sessionId, 'append', options.signal, (signal) =>
      this.runWithSessionLock(
        sessionId,
        'write',
        async () => {
          const loaded = await this.loadLog(sessionId, signal);
          const previousSequence = loaded.events.at(-1)?.sequence ?? null;
          this.assertExpectedSequence(options.expectedLastSequence, previousSequence);

          const eventIds = new Set<string>(loaded.events.map((event) => event.eventId));
          const now = this.clock();
          await this.assertExecutionFenceUnlocked(sessionId, options.executionFence, now, signal);
          const recordedAt = now.toISOString();
          const firstSequenceValue = Number(previousSequence ?? 0) + 1;
          const events = parsedDrafts.map((draft, index): DurableEventEnvelope => {
            const eventId = this.eventIdFactory();
            if (eventIds.has(eventId)) {
              throw new DurableEventStoreError(
                'DURABLE_EVENT_INVALID_APPEND',
                `Duplicate generated durable event ID: ${eventId}`,
              );
            }
            eventIds.add(eventId);
            return {
              ...draft,
              schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
              eventId,
              sequence: EventSequence(firstSequenceValue + index),
              sessionId,
              recordedAt,
              occurredAt: draft.occurredAt ?? recordedAt,
            };
          });
          const firstEvent = events[0];
          const lastEvent = events.at(-1);
          if (!firstEvent || !lastEvent) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_APPEND',
              'A durable event append produced no events',
            );
          }
          const lastSequence = lastEvent.sequence;

          const batch: PersistedDurableEventBatch = {
            format: DURABLE_EVENT_LOG_FORMAT,
            schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
            sessionId,
            firstSequence: firstEvent.sequence,
            lastSequence,
            events,
          };

          let validatedBatch: PersistedDurableEventBatch;
          try {
            validatedBatch = parsePersistedDurableEventBatch(batch);
          } catch (error) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_APPEND',
              'Generated durable event batch is invalid',
              { cause: error },
            );
          }

          await this.writeBatch(sessionId, validatedBatch, loaded, signal);
          return {
            events: structuredClone(validatedBatch.events),
            previousSequence,
            lastSequence,
          };
        },
        signal,
      ),
    );
  }

  async read(
    sessionId: SessionId,
    options: DurableEventReadOptions = {},
  ): Promise<DurableEventPage> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_CURSOR',
        `Durable event read limit must be between 1 and ${MAX_PAGE_SIZE}`,
      );
    }

    return this.runEventOperation(sessionId, 'read', options.signal, (signal) =>
      this.runWithSessionLock(
        sessionId,
        'read',
        async () => {
          const { events } = await this.loadLog(sessionId, signal);
          const headSequence = events.at(-1)?.sequence ?? null;
          const after = options.after;
          if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_CURSOR',
              `Invalid durable event cursor: ${String(after)}`,
            );
          }
          if (after !== undefined && after > (headSequence ?? 0)) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_CURSOR',
              `Durable event cursor ${after} is ahead of head ${headSequence}`,
            );
          }

          const unread =
            after === undefined ? events : events.filter((event) => event.sequence > after);
          const pageEvents = unread.slice(0, limit);
          return {
            events: structuredClone(pageEvents),
            headSequence,
            nextCursor: pageEvents.at(-1)?.sequence ?? after ?? null,
            hasMore: unread.length > pageEvents.length,
          };
        },
        signal,
      ),
    );
  }

  async getHeadSequence(
    sessionId: SessionId,
    options: DurableEventOperationOptions = {},
  ): Promise<EventSequence | null> {
    return this.runEventOperation(sessionId, 'get_head_sequence', options.signal, (signal) =>
      this.runWithSessionLock(
        sessionId,
        'read',
        async () => {
          const { events } = await this.loadLog(sessionId, signal);
          return events.at(-1)?.sequence ?? null;
        },
        signal,
      ),
    );
  }

  getFilePath(sessionId: SessionId): string {
    const filename = `${Buffer.from(sessionId).toString('base64url')}.jsonl`;
    return join(this.rootDirectory, filename);
  }

  getExecutionLeaseFilePath(sessionId: SessionId): string {
    const filename = `${Buffer.from(sessionId).toString('base64url')}.lease.json`;
    return join(this.rootDirectory, filename);
  }

  async requiresExecutionLease(
    sessionId: SessionId,
    options: DurableEventOperationOptions = {},
  ): Promise<boolean> {
    return this.runLeaseOperation(sessionId, 'requires', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        sessionId,
        'read',
        async () => {
          return (await this.loadExecutionLeaseState(sessionId, signal)) !== null;
        },
        signal,
      ),
    );
  }

  async acquireExecutionLease(
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease> {
    this.assertLeaseIdentity(sessionId, options);
    this.assertLeaseTtl(options.ttlMs);
    return this.runLeaseOperation(sessionId, 'acquire', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        sessionId,
        'write',
        async () => {
          const current = await this.loadExecutionLeaseState(sessionId, signal);
          const now = this.clock();
          if (current && this.isLeaseActive(current, now)) {
            if (current.leaseId !== options.leaseId || current.ownerId !== options.ownerId) {
              throw new DurableExecutionLeaseError(
                'DURABLE_EXECUTION_LEASE_CONFLICT',
                `Session ${sessionId} is leased by worker ${current.ownerId}`,
                {
                  sessionId,
                  leaseId: options.leaseId,
                  fencingToken: current.fencingToken,
                  activeLease: this.toExecutionLease(current),
                },
              );
            }
          }

          const reusesActiveLease =
            current !== null &&
            this.isLeaseActive(current, now) &&
            current.leaseId === options.leaseId &&
            current.ownerId === options.ownerId;
          const fencingToken = reusesActiveLease
            ? current.fencingToken
            : this.nextFencingToken(sessionId, current?.fencingToken);
          const timestamp = now.toISOString();
          const state: PersistedDurableExecutionLeaseState = {
            format: DURABLE_EXECUTION_LEASE_FORMAT,
            version: DURABLE_EXECUTION_LEASE_FORMAT_VERSION,
            sessionId,
            fencingToken,
            leaseId: options.leaseId,
            ownerId: options.ownerId,
            acquiredAt: reusesActiveLease ? current.acquiredAt : timestamp,
            renewedAt: timestamp,
            expiresAt: this.expiresAt(sessionId, now, options.ttlMs),
          };
          await this.writeExecutionLeaseState(state, signal);
          return this.toExecutionLease(state);
        },
        signal,
      ),
    );
  }

  async renewExecutionLease(
    lease: DurableExecutionLease,
    ttlMs: number,
    options: DurableEventOperationOptions = {},
  ): Promise<DurableExecutionLease> {
    this.assertLeaseIdentity(lease.sessionId, lease);
    this.assertLeaseTtl(ttlMs);
    return this.runLeaseOperation(lease.sessionId, 'renew', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        lease.sessionId,
        'write',
        async () => {
          const current = await this.loadExecutionLeaseState(lease.sessionId, signal);
          const now = this.clock();
          this.assertLeaseMatches(lease, current, now);
          if (!current) {
            throw this.createLeaseLostError(lease, 'no lease state exists');
          }
          const timestamp = now.toISOString();
          const renewed: PersistedDurableExecutionLeaseState = {
            ...current,
            renewedAt: timestamp,
            expiresAt: this.expiresAt(lease.sessionId, now, ttlMs),
          };
          await this.writeExecutionLeaseState(renewed, signal);
          return this.toExecutionLease(renewed);
        },
        signal,
      ),
    );
  }

  async assertExecutionLease(
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertLeaseIdentity(lease.sessionId, lease);
    await this.runLeaseOperation(lease.sessionId, 'assert', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        lease.sessionId,
        'read',
        async () => {
          const current = await this.loadExecutionLeaseState(lease.sessionId, signal);
          this.assertLeaseMatches(lease, current, this.clock());
        },
        signal,
      ),
    );
  }

  async withExecutionLease<T>(
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options: DurableEventOperationOptions = {},
  ): Promise<T> {
    this.assertLeaseIdentity(lease.sessionId, lease);
    return this.runLeaseOperation(lease.sessionId, 'with', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        lease.sessionId,
        'write',
        async () => {
          const current = await this.loadExecutionLeaseState(lease.sessionId, signal);
          this.assertLeaseMatches(lease, current, this.clock());
          signal.throwIfAborted();
          const result = await operation();
          signal.throwIfAborted();
          return result;
        },
        signal,
      ),
    );
  }

  async releaseExecutionLease(
    lease: DurableExecutionLease,
    options: DurableEventOperationOptions = {},
  ): Promise<void> {
    this.assertLeaseIdentity(lease.sessionId, lease);
    await this.runLeaseOperation(lease.sessionId, 'release', options.signal, (signal) =>
      this.runWithExecutionLeaseLock(
        lease.sessionId,
        'write',
        async () => {
          const current = await this.loadExecutionLeaseState(lease.sessionId, signal);
          const now = this.clock();
          if (
            current?.releasedAt &&
            current.leaseId === lease.leaseId &&
            current.fencingToken === lease.fencingToken
          ) {
            return;
          }
          this.assertLeaseMatches(lease, current, now, false);
          if (!current) {
            throw this.createLeaseLostError(lease, 'no lease state exists');
          }
          await this.writeExecutionLeaseState(
            {
              ...current,
              releasedAt: now.toISOString(),
            },
            signal,
          );
        },
        signal,
      ),
    );
  }

  private runEventOperation<T>(
    sessionId: SessionId,
    operation: DurableEventStoreOperation,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    return awaitDurableStoreOperation(
      {
        timeoutMs: this.operationTimeoutMs,
        signal,
        createTimeoutError: () =>
          new DurableEventStoreTimeoutError(operation, sessionId, this.operationTimeoutMs),
      },
      execute,
    );
  }

  private runLeaseOperation<T>(
    sessionId: SessionId,
    operation: DurableExecutionLeaseOperation,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    return awaitDurableStoreOperation(
      {
        timeoutMs: this.operationTimeoutMs,
        signal,
        createTimeoutError: () =>
          new DurableExecutionLeaseTimeoutError(operation, this.operationTimeoutMs, { sessionId }),
      },
      execute,
    );
  }

  private async runWithSessionLock<T>(
    sessionId: SessionId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    const operationErrorCode =
      operation === 'write' ? 'DURABLE_EVENT_WRITE_FAILED' : 'DURABLE_EVENT_READ_FAILED';
    return withAdvisoryFileLock(
      this.getFilePath(sessionId),
      {
        timeoutMs: this.lockTimeoutMs,
        signal,
        errors: {
          prepare: (cause) =>
            new DurableEventStoreError(
              'DURABLE_EVENT_LOCK_FAILED',
              `Failed to prepare durable event lock for session ${sessionId}`,
              { cause },
            ),
          initialize: (cause) =>
            new DurableEventStoreError(
              'DURABLE_EVENT_LOCK_FAILED',
              `Failed to initialize durable event locking for session ${sessionId}`,
              { cause },
            ),
          acquire: (cause) =>
            new DurableEventStoreError(
              'DURABLE_EVENT_LOCK_FAILED',
              `Failed to acquire durable event lock for session ${sessionId}`,
              { cause },
            ),
          timeout: () => this.createLockTimeoutError(sessionId),
          release: (cause) =>
            new DurableEventStoreError(
              operationErrorCode,
              `Durable event ${operation} failed while holding the Session lock for ${sessionId}`,
              { cause },
            ),
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

  private createLockTimeoutError(sessionId: SessionId): DurableEventStoreError {
    return new DurableEventStoreError(
      'DURABLE_EVENT_LOCK_TIMEOUT',
      `Timed out acquiring durable event lock for session ${sessionId}`,
    );
  }

  private assertExpectedSequence(
    expected: EventSequence | null | undefined,
    actual: EventSequence | null,
  ): void {
    if (expected !== undefined && expected !== actual) {
      throw new DurableEventSequenceConflictError(expected, actual);
    }
  }

  private async runWithExecutionLeaseLock<T>(
    sessionId: SessionId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    return withAdvisoryFileLock(
      this.getFilePath(sessionId),
      {
        timeoutMs: this.lockTimeoutMs,
        signal,
        errors: {
          prepare: (cause) => this.createLeaseStorageError(sessionId, operation, cause),
          initialize: (cause) => this.createLeaseStorageError(sessionId, operation, cause),
          acquire: (cause) => this.createLeaseStorageError(sessionId, operation, cause),
          timeout: () =>
            new DurableExecutionLeaseError(
              'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
              `Timed out acquiring the execution lease lock for Session ${sessionId}`,
              { sessionId },
            ),
          release: (cause) => this.createLeaseStorageError(sessionId, operation, cause),
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

  private createLeaseStorageError(
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

  private async loadExecutionLeaseState(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<PersistedDurableExecutionLeaseState | null> {
    const filePath = this.getExecutionLeaseFilePath(sessionId);
    let content: string;
    try {
      content = await readFile(filePath, { encoding: 'utf8', signal });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw this.createLeaseStorageError(sessionId, 'read', error);
    }
    try {
      const state = parsePersistedDurableExecutionLeaseState(JSON.parse(content));
      if (state.sessionId !== sessionId) {
        throw new Error(`Lease state belongs to Session ${state.sessionId}`);
      }
      return state;
    } catch (error) {
      if (error instanceof DurableExecutionLeaseError) {
        throw error;
      }
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_CORRUPT',
        `Invalid execution lease state for Session ${sessionId}`,
        { sessionId, cause: error },
      );
    }
  }

  private async writeExecutionLeaseState(
    state: PersistedDurableExecutionLeaseState,
    signal: AbortSignal,
  ): Promise<void> {
    const filePath = this.getExecutionLeaseFilePath(state.sessionId);
    try {
      const validated = parsePersistedDurableExecutionLeaseState(state);
      signal.throwIfAborted();
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      await writeFileAtomic(filePath, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        fsync: true,
        mode: 0o600,
      });
      signal.throwIfAborted();
      await syncParentDirectory(filePath);
      signal.throwIfAborted();
    } catch (error) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_WRITE_FAILED',
        `Failed to persist the execution lease for Session ${state.sessionId}`,
        { sessionId: state.sessionId, cause: error },
      );
    }
  }

  private async assertExecutionFenceUnlocked(
    sessionId: SessionId,
    fence: DurableExecutionFence | undefined,
    now: Date,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.loadExecutionLeaseState(sessionId, signal);
    if (!current) {
      if (fence) {
        throw new DurableExecutionLeaseError(
          'DURABLE_EXECUTION_LEASE_LOST',
          `Execution lease ${fence.leaseId} does not exist for Session ${sessionId}`,
          {
            sessionId,
            leaseId: fence.leaseId,
            fencingToken: fence.fencingToken,
          },
        );
      }
      return;
    }
    if (!fence) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_REQUIRED',
        `Session ${sessionId} requires an execution lease`,
        {
          sessionId,
          ...(this.isLeaseActive(current, now)
            ? { activeLease: this.toExecutionLease(current) }
            : {}),
        },
      );
    }
    if (!this.isLeaseActive(current, now)) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${fence.leaseId} is not active for Session ${sessionId}`,
        {
          sessionId,
          leaseId: fence.leaseId,
          fencingToken: fence.fencingToken,
        },
      );
    }
    if (current.leaseId !== fence.leaseId || current.fencingToken !== fence.fencingToken) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_LOST',
        `Execution lease ${fence.leaseId} is stale for Session ${sessionId}`,
        {
          sessionId,
          leaseId: fence.leaseId,
          fencingToken: fence.fencingToken,
          activeLease: this.toExecutionLease(current),
        },
      );
    }
  }

  private assertLeaseMatches(
    lease: DurableExecutionLease,
    current: PersistedDurableExecutionLeaseState | null,
    now: Date,
    requireUnexpired = true,
  ): void {
    if (
      !current ||
      current.releasedAt ||
      current.leaseId !== lease.leaseId ||
      current.ownerId !== lease.ownerId ||
      current.fencingToken !== lease.fencingToken ||
      (requireUnexpired && !this.isLeaseActive(current, now))
    ) {
      throw this.createLeaseLostError(
        lease,
        current?.releasedAt
          ? 'it was released'
          : current && !this.isLeaseActive(current, now)
            ? 'it expired'
            : 'another owner holds the lease',
        current && this.isLeaseActive(current, now) ? this.toExecutionLease(current) : undefined,
      );
    }
  }

  private createLeaseLostError(
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

  private assertLeaseIdentity(
    sessionId: SessionId,
    lease: {
      readonly sessionId?: SessionId;
      readonly leaseId: DurableExecutionLease['leaseId'];
      readonly ownerId: DurableExecutionLease['ownerId'];
    },
  ): void {
    if (
      sessionId.trim() === '' ||
      lease.leaseId.trim() === '' ||
      lease.ownerId.trim() === '' ||
      ('sessionId' in lease && lease.sessionId !== sessionId)
    ) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Invalid execution lease identity for Session ${sessionId}`,
        {
          sessionId,
          leaseId: lease.leaseId,
        },
      );
    }
  }

  private assertLeaseTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_EXECUTION_LEASE_TTL_MS) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        `Execution lease ttlMs must be between 1 and ${MAX_EXECUTION_LEASE_TTL_MS}`,
      );
    }
  }

  private nextFencingToken(sessionId: SessionId, current: FencingToken | undefined): FencingToken {
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

  private isLeaseActive(state: PersistedDurableExecutionLeaseState, now: Date): boolean {
    return state.releasedAt === undefined && Date.parse(state.expiresAt) > now.getTime();
  }

  private toExecutionLease(state: PersistedDurableExecutionLeaseState): DurableExecutionLease {
    return {
      sessionId: state.sessionId,
      leaseId: state.leaseId,
      ownerId: state.ownerId,
      fencingToken: state.fencingToken,
      acquiredAt: state.acquiredAt,
      renewedAt: state.renewedAt,
      expiresAt: state.expiresAt,
    };
  }

  private async writeBatch(
    sessionId: SessionId,
    batch: PersistedDurableEventBatch,
    loaded: LoadedLog,
    signal: AbortSignal,
  ): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    try {
      signal.throwIfAborted();
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      if (loaded.totalBytes > loaded.committedBytes) {
        signal.throwIfAborted();
        await truncate(filePath, loaded.committedBytes);
      }
      signal.throwIfAborted();
      const file = await open(filePath, 'a', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(batch)}\n`, {
          encoding: 'utf8',
          signal,
        });
        signal.throwIfAborted();
        await file.sync();
        signal.throwIfAborted();
      } finally {
        await file.close();
      }
      if (!loaded.exists) {
        signal.throwIfAborted();
        await syncParentDirectory(filePath);
        signal.throwIfAborted();
      }
    } catch (error) {
      if (error instanceof DurableEventStoreError) {
        throw error;
      }
      throw new DurableEventStoreError(
        'DURABLE_EVENT_WRITE_FAILED',
        `Failed to append durable events for session ${sessionId}`,
        { cause: error },
      );
    }
  }

  private async loadLog(sessionId: SessionId, signal: AbortSignal): Promise<LoadedLog> {
    const filePath = this.getFilePath(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath, { signal });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return {
          events: [],
          exists: false,
          committedBytes: 0,
          totalBytes: 0,
        };
      }
      throw new DurableEventStoreError(
        'DURABLE_EVENT_READ_FAILED',
        `Failed to read durable events for session ${sessionId}`,
        { cause: error },
      );
    }

    const lastNewline = bytes.lastIndexOf(0x0a);
    const committedBytes = lastNewline === -1 ? 0 : lastNewline + 1;
    const committed = bytes.subarray(0, committedBytes).toString('utf8');
    const lines = committed.split('\n').filter(Boolean);
    const events: DurableEventEnvelope[] = [];
    const eventIds = new Set<string>();
    let expectedSequence = 1;
    let previousSchemaVersion: DurableEventSchemaVersion | null = null;

    for (const [index, line] of lines.entries()) {
      let batch: PersistedDurableEventBatch;
      try {
        batch = parsePersistedDurableEventBatch(JSON.parse(line));
      } catch (error) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_CORRUPT_LOG',
          `Invalid durable event batch at line ${index + 1} for session ${sessionId}`,
          { cause: error },
        );
      }

      this.assertBatchIntegrity(
        batch,
        sessionId,
        expectedSequence,
        previousSchemaVersion,
        eventIds,
      );
      events.push(...batch.events);
      expectedSequence = Number(batch.lastSequence) + 1;
      previousSchemaVersion = batch.schemaVersion;
    }

    return {
      events,
      exists: true,
      committedBytes,
      totalBytes: bytes.length,
    };
  }

  private assertBatchIntegrity(
    batch: PersistedDurableEventBatch,
    sessionId: SessionId,
    expectedFirstSequence: number,
    previousSchemaVersion: DurableEventSchemaVersion | null,
    eventIds: Set<string>,
  ): void {
    const firstSequence = Number(batch.firstSequence);
    const lastSequence = Number(batch.lastSequence);
    if (
      batch.sessionId !== sessionId ||
      firstSequence !== expectedFirstSequence ||
      lastSequence !== firstSequence + batch.events.length - 1
    ) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_CORRUPT_LOG',
        `Non-contiguous durable event batch for session ${sessionId}`,
      );
    }
    if (previousSchemaVersion !== null && batch.schemaVersion < previousSchemaVersion) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_CORRUPT_LOG',
        `Durable event schema regressed from v${previousSchemaVersion} to v${batch.schemaVersion}`,
      );
    }

    for (const [index, event] of batch.events.entries()) {
      if (
        event.sessionId !== sessionId ||
        Number(event.sequence) !== firstSequence + index ||
        eventIds.has(event.eventId)
      ) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_CORRUPT_LOG',
          `Invalid durable event envelope for session ${sessionId}`,
        );
      }
      eventIds.add(event.eventId);
    }
  }
}
