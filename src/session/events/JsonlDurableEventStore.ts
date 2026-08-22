import { Buffer } from 'node:buffer';
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { EventId, EventSequence, type SessionId } from '../../types/branded.js';
import {
  DurableEventSequenceConflictError,
  type DurableEventStore,
  DurableEventStoreError,
} from './DurableEventStore.js';
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

interface FileMutexEntry {
  mutex: Mutex;
  users: number;
}

const FILE_MUTEXES = new Map<string, FileMutexEntry>();

async function runWithFileMutex<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
  let entry = FILE_MUTEXES.get(filePath);
  if (!entry) {
    entry = { mutex: new Mutex(), users: 0 };
    FILE_MUTEXES.set(filePath, entry);
  }
  entry.users += 1;
  try {
    return await entry.mutex.runExclusive(callback);
  } finally {
    entry.users -= 1;
    if (entry.users === 0) {
      FILE_MUTEXES.delete(filePath);
    }
  }
}

export interface JsonlDurableEventStoreOptions {
  clock?: () => Date;
  eventIdFactory?: () => EventId;
}

interface LoadedLog {
  events: DurableEventEnvelope[];
  committedBytes: number;
  totalBytes: number;
}

/**
 * Durable local adapter for a single Node.js process.
 *
 * Appends are serialized across store instances in this process. Multi-process
 * or distributed executors must provide a store with external CAS/fencing.
 */
export class JsonlDurableEventStore implements DurableEventStore {
  private readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly eventIdFactory: () => EventId;

  constructor(storageRoot: string, options: JsonlDurableEventStoreOptions = {}) {
    if (storageRoot.trim() === '') {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_INVALID_APPEND',
        'Durable event storage root must not be empty',
      );
    }
    this.rootDirectory = resolve(storageRoot, EVENT_DIRECTORY);
    this.clock = options.clock ?? (() => new Date());
    this.eventIdFactory = options.eventIdFactory ?? (() => EventId(nanoid()));
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

    return runWithFileMutex(this.getFilePath(sessionId), async () => {
      const loaded = await this.loadLog(sessionId);
      const previousSequence = loaded.events.at(-1)?.sequence ?? null;
      this.assertExpectedSequence(options.expectedLastSequence, previousSequence);

      const eventIds = new Set<string>(loaded.events.map((event) => event.eventId));
      const recordedAt = this.clock().toISOString();
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

      await this.writeBatch(sessionId, validatedBatch, loaded);
      return {
        events: structuredClone(validatedBatch.events),
        previousSequence,
        lastSequence,
      };
    });
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

    return runWithFileMutex(this.getFilePath(sessionId), async () => {
      const { events } = await this.loadLog(sessionId);
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
    });
  }

  async getHeadSequence(sessionId: SessionId): Promise<EventSequence | null> {
    return runWithFileMutex(this.getFilePath(sessionId), async () => {
      const { events } = await this.loadLog(sessionId);
      return events.at(-1)?.sequence ?? null;
    });
  }

  getFilePath(sessionId: SessionId): string {
    const filename = `${Buffer.from(sessionId).toString('base64url')}.jsonl`;
    return join(this.rootDirectory, filename);
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
  ): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    try {
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      if (loaded.totalBytes > loaded.committedBytes) {
        await truncate(filePath, loaded.committedBytes);
      }
      const file = await open(filePath, 'a', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(batch)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_WRITE_FAILED',
        `Failed to append durable events for session ${sessionId}`,
        { cause: error },
      );
    }
  }

  private async loadLog(sessionId: SessionId): Promise<LoadedLog> {
    const filePath = this.getFilePath(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { events: [], committedBytes: 0, totalBytes: 0 };
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

      this.assertBatchIntegrity(batch, sessionId, expectedSequence, eventIds);
      events.push(...batch.events);
      expectedSequence = Number(batch.lastSequence) + 1;
    }

    return {
      events,
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
