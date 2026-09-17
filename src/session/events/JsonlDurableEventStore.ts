import { Buffer } from 'node:buffer';
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { EventId, EventSequence, type SessionId } from '../../types/identifiers.js';
import { syncParentDirectory, withAdvisoryFileLock } from '../../utils/advisoryFileLock.js';
import {
  type DurableEventOperationOptions,
  DurableEventSequenceConflictError,
  DurableEventStoreError,
  type DurableEventStoreOperation,
  DurableEventStoreTimeoutError,
} from './DurableEventStore.js';
import type {
  DurableExecutionLease,
  DurableExecutionLeaseAcquireOptions,
  DurableExecutionLeaseStore,
} from './DurableExecutionLeaseStore.js';
import {
  awaitDurableStoreOperation,
  DEFAULT_DURABLE_STORE_TIMEOUT_MS,
  MAX_DURABLE_STORE_TIMEOUT_MS,
  resolveDurableStoreTimeoutMs,
} from './DurableStoreOperation.js';
import { JsonlExecutionLeaseStore } from './JsonlExecutionLeaseStore.js';
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
} from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const EVENT_DIRECTORY = 'durable-events';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

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
 */
export class JsonlDurableEventStore implements DurableExecutionLeaseStore {
  private readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly eventIdFactory: () => EventId;
  private readonly lockTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly leases: JsonlExecutionLeaseStore;

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
    const fallback = Math.min(
      MAX_DURABLE_STORE_TIMEOUT_MS,
      this.lockTimeoutMs + DEFAULT_DURABLE_STORE_TIMEOUT_MS,
    );
    try {
      this.operationTimeoutMs = resolveDurableStoreTimeoutMs(
        options.operationTimeoutMs,
        fallback,
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
    this.leases = new JsonlExecutionLeaseStore({
      rootDirectory: this.rootDirectory,
      clock: this.clock,
      lockTimeoutMs: this.lockTimeoutMs,
      operationTimeoutMs: this.operationTimeoutMs,
      lockPath: (sessionId) => this.getFilePath(sessionId),
    });
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
      } catch (cause) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_INVALID_APPEND',
          `Invalid durable event draft at index ${index}`,
          { cause },
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
          await this.leases.assertFence(sessionId, options.executionFence, this.clock(), signal);

          const eventIds = new Set(loaded.events.map((event) => event.eventId));
          const recordedAt = this.clock().toISOString();
          const firstSequence = Number(previousSequence ?? 0) + 1;
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
              sequence: EventSequence(firstSequence + index),
              sessionId,
              recordedAt,
              occurredAt: draft.occurredAt ?? recordedAt,
            };
          });
          const first = events[0];
          const last = events.at(-1);
          if (!first || !last) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_APPEND',
              'A durable event append produced no events',
            );
          }
          let batch: PersistedDurableEventBatch;
          try {
            batch = parsePersistedDurableEventBatch({
              format: DURABLE_EVENT_LOG_FORMAT,
              schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
              sessionId,
              firstSequence: first.sequence,
              lastSequence: last.sequence,
              events,
            });
          } catch (cause) {
            throw new DurableEventStoreError(
              'DURABLE_EVENT_INVALID_APPEND',
              'Generated durable event batch is invalid',
              { cause },
            );
          }
          await this.writeBatch(sessionId, batch, loaded, signal);
          return {
            events: structuredClone(batch.events),
            previousSequence,
            lastSequence: last.sequence,
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
          const page = unread.slice(0, limit);
          return {
            events: structuredClone(page),
            headSequence,
            nextCursor: page.at(-1)?.sequence ?? after ?? null,
            hasMore: unread.length > page.length,
          };
        },
        signal,
      ),
    );
  }

  getHeadSequence(
    sessionId: SessionId,
    options: DurableEventOperationOptions = {},
  ): Promise<EventSequence | null> {
    return this.runEventOperation(sessionId, 'get_head_sequence', options.signal, (signal) =>
      this.runWithSessionLock(
        sessionId,
        'read',
        async () => (await this.loadLog(sessionId, signal)).events.at(-1)?.sequence ?? null,
        signal,
      ),
    );
  }

  getFilePath(sessionId: SessionId): string {
    return join(this.rootDirectory, `${Buffer.from(sessionId).toString('base64url')}.jsonl`);
  }

  getExecutionLeaseFilePath(sessionId: SessionId): string {
    return this.leases.filePath(sessionId);
  }

  requiresExecutionLease(
    sessionId: SessionId,
    options?: DurableEventOperationOptions,
  ): Promise<boolean> {
    return this.leases.requires(sessionId, options);
  }

  acquireExecutionLease(
    sessionId: SessionId,
    options: DurableExecutionLeaseAcquireOptions,
  ): Promise<DurableExecutionLease> {
    return this.leases.acquire(sessionId, options);
  }

  renewExecutionLease(
    lease: DurableExecutionLease,
    ttlMs: number,
    options?: DurableEventOperationOptions,
  ): Promise<DurableExecutionLease> {
    return this.leases.renew(lease, ttlMs, options);
  }

  assertExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void> {
    return this.leases.assert(lease, options);
  }

  withExecutionLease<T>(
    lease: DurableExecutionLease,
    operation: () => Promise<T>,
    options?: DurableEventOperationOptions,
  ): Promise<T> {
    return this.leases.withLease(lease, operation, options);
  }

  releaseExecutionLease(
    lease: DurableExecutionLease,
    options?: DurableEventOperationOptions,
  ): Promise<void> {
    return this.leases.release(lease, options);
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

  private runWithSessionLock<T>(
    sessionId: SessionId,
    operation: 'read' | 'write',
    callback: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const operationErrorCode =
      operation === 'write' ? 'DURABLE_EVENT_WRITE_FAILED' : 'DURABLE_EVENT_READ_FAILED';
    const lockError = (message: string, cause?: unknown) =>
      new DurableEventStoreError('DURABLE_EVENT_LOCK_FAILED', message, { cause });
    return withAdvisoryFileLock(
      this.getFilePath(sessionId),
      {
        timeoutMs: this.lockTimeoutMs,
        signal,
        errors: {
          prepare: (cause) =>
            lockError(`Failed to prepare durable event lock for session ${sessionId}`, cause),
          initialize: (cause) =>
            lockError(`Failed to initialize durable event locking for session ${sessionId}`, cause),
          acquire: (cause) =>
            lockError(`Failed to acquire durable event lock for session ${sessionId}`, cause),
          timeout: () =>
            new DurableEventStoreError(
              'DURABLE_EVENT_LOCK_TIMEOUT',
              `Timed out acquiring durable event lock for session ${sessionId}`,
            ),
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

  private assertExpectedSequence(
    expected: EventSequence | null | undefined,
    actual: EventSequence | null,
  ): void {
    if (expected !== undefined && expected !== actual) {
      throw new DurableEventSequenceConflictError(expected, actual);
    }
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
        await file.writeFile(`${JSON.stringify(batch)}\n`, { encoding: 'utf8', signal });
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
    } catch (cause) {
      if (cause instanceof DurableEventStoreError) throw cause;
      throw new DurableEventStoreError(
        'DURABLE_EVENT_WRITE_FAILED',
        `Failed to append durable events for session ${sessionId}`,
        { cause },
      );
    }
  }

  private async loadLog(sessionId: SessionId, signal: AbortSignal): Promise<LoadedLog> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.getFilePath(sessionId), { signal });
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        return { events: [], exists: false, committedBytes: 0, totalBytes: 0 };
      }
      throw new DurableEventStoreError(
        'DURABLE_EVENT_READ_FAILED',
        `Failed to read durable events for session ${sessionId}`,
        { cause },
      );
    }

    const committedBytes = bytes.lastIndexOf(0x0a) + 1;
    const lines = bytes.subarray(0, committedBytes).toString('utf8').split('\n').filter(Boolean);
    const events: DurableEventEnvelope[] = [];
    const eventIds = new Set<string>();
    let expectedSequence = 1;
    for (const [index, line] of lines.entries()) {
      let batch: PersistedDurableEventBatch;
      try {
        batch = parsePersistedDurableEventBatch(JSON.parse(line));
      } catch (cause) {
        throw new DurableEventStoreError(
          'DURABLE_EVENT_CORRUPT_LOG',
          `Invalid durable event batch at line ${index + 1} for session ${sessionId}`,
          { cause },
        );
      }
      this.assertBatchIntegrity(batch, sessionId, expectedSequence, eventIds);
      events.push(...batch.events);
      expectedSequence = Number(batch.lastSequence) + 1;
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
    eventIds: Set<string>,
  ): void {
    const firstSequence = Number(batch.firstSequence);
    if (
      batch.sessionId !== sessionId ||
      firstSequence !== expectedFirstSequence ||
      Number(batch.lastSequence) !== firstSequence + batch.events.length - 1
    ) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_CORRUPT_LOG',
        `Non-contiguous durable event batch for session ${sessionId}`,
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
