import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventId, EventSequence, RequestId, SessionId, TurnId } from '../../../types/branded.js';
import { DurableEventSequenceConflictError, DurableEventStoreError } from '../DurableEventStore.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DURABLE_EVENT_LOG_FORMAT } from '../schemas.js';
import { DURABLE_EVENT_SCHEMA_VERSION, DurableEventType } from '../types.js';

describe('JsonlDurableEventStore', () => {
  let storageRoot: string;
  let nextEventId: number;
  let store: JsonlDurableEventStore;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-store-'));
    nextEventId = 0;
    store = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:00.000Z'),
      eventIdFactory: () => EventId(`event-${++nextEventId}`),
    });
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('returns an empty page for a new session', async () => {
    const sessionId = SessionId('session-empty');

    await expect(store.getHeadSequence(sessionId)).resolves.toBeNull();
    await expect(store.read(sessionId)).resolves.toEqual({
      events: [],
      headSequence: null,
      nextCursor: null,
      hasMore: false,
    });
  });

  it('assigns contiguous sequences and resumes them after reopening', async () => {
    const sessionId = SessionId('session-sequences');
    const first = await store.append(
      sessionId,
      [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-1'),
          data: { inputId: 'input-1', priority: 'next' },
        },
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId: RequestId('request-1'),
          data: {},
        },
      ],
      { expectedLastSequence: null },
    );

    expect(first.previousSequence).toBeNull();
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.lastSequence).toBe(2);

    const reopened = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:01.000Z'),
      eventIdFactory: () => EventId('event-3'),
    });
    const second = await reopened.append(
      sessionId,
      [
        {
          type: DurableEventType.TURN_STARTED,
          requestId: RequestId('request-1'),
          turnId: TurnId('turn-1'),
          data: { turn: 1 },
        },
      ],
      { expectedLastSequence: EventSequence(2) },
    );

    expect(second.events[0]?.sequence).toBe(3);
    expect(await reopened.getHeadSequence(sessionId)).toBe(3);
    expect((await reopened.read(sessionId)).events.map((event) => event.eventId)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ]);
  });

  it('reads exclusive cursor pages without gaps', async () => {
    const sessionId = SessionId('session-pagination');
    await store.append(sessionId, [
      { type: DurableEventType.SESSION_CREATED, data: {} },
      { type: DurableEventType.REQUEST_ACCEPTED, data: {} },
      { type: DurableEventType.REQUEST_STARTED, data: {} },
    ]);

    const firstPage = await store.read(sessionId, { limit: 2 });
    expect(firstPage.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe(2);
    expect(firstPage.headSequence).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await store.read(sessionId, {
      after: firstPage.nextCursor ?? undefined,
      limit: 2,
    });
    expect(secondPage.events.map((event) => event.sequence)).toEqual([3]);
    expect(secondPage.nextCursor).toBe(3);
    expect(secondPage.hasMore).toBe(false);
  });

  it('allows only one concurrent compare-and-append writer', async () => {
    const sessionId = SessionId('session-conflict');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
      expectedLastSequence: null,
    });
    const competingStore = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('competing-event'),
    });

    const results = await Promise.allSettled([
      competingStore.append(
        sessionId,
        [{ type: DurableEventType.REQUEST_ACCEPTED, data: { writer: 'a' } }],
        { expectedLastSequence: EventSequence(1) },
      ),
      store.append(
        sessionId,
        [{ type: DurableEventType.REQUEST_ACCEPTED, data: { writer: 'b' } }],
        { expectedLastSequence: EventSequence(1) },
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        expectedSequence: 1,
        actualSequence: 2,
      }),
    });
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(DurableEventSequenceConflictError);
    }
    expect(await store.getHeadSequence(sessionId)).toBe(2);
  });

  it('rejects duplicate event IDs across append batches', async () => {
    const sessionId = SessionId('session-duplicate-event-id');
    const duplicateStore = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('duplicate-event'),
    });
    await duplicateStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    await expect(
      duplicateStore.append(sessionId, [{ type: DurableEventType.REQUEST_ACCEPTED, data: {} }]),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    expect(await duplicateStore.getHeadSequence(sessionId)).toBe(1);
  });

  it('ignores and truncates an incomplete trailing batch after a crash', async () => {
    const sessionId = SessionId('session-torn-tail');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    const filePath = store.getFilePath(sessionId);
    await appendFile(filePath, '{"format":"blade.durable-events"');

    const reopened = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:01.000Z'),
      eventIdFactory: () => EventId('event-after-crash'),
    });
    expect((await reopened.read(sessionId)).events).toHaveLength(1);

    await reopened.append(sessionId, [{ type: DurableEventType.REQUEST_ACCEPTED, data: {} }], {
      expectedLastSequence: EventSequence(1),
    });

    expect((await reopened.read(sessionId)).events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(await readFile(filePath, 'utf8')).not.toContain(
      '{"format":"blade.durable-events"{"format"',
    );
  });

  it('rejects a corrupt committed batch', async () => {
    const sessionId = SessionId('session-corrupt');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    await appendFile(store.getFilePath(sessionId), '{"invalid":true}\n');

    await expect(store.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_CORRUPT_LOG',
    });
  });

  it('rejects non-contiguous committed sequences', async () => {
    const sessionId = SessionId('session-sequence-gap');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    const timestamp = '2026-08-22T12:00:01.000Z';
    await appendFile(
      store.getFilePath(sessionId),
      `${JSON.stringify({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        sessionId,
        firstSequence: 3,
        lastSequence: 3,
        events: [
          {
            schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
            eventId: 'event-gap',
            sequence: 3,
            sessionId,
            type: DurableEventType.REQUEST_ACCEPTED,
            data: {},
            recordedAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      })}\n`,
    );

    await expect(store.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_CORRUPT_LOG',
    });
  });

  it('rejects invalid appends before creating a log', async () => {
    const sessionId = SessionId('session-invalid');

    await expect(store.append(sessionId, [])).rejects.toBeInstanceOf(DurableEventStoreError);
    await expect(
      store.append(sessionId, [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          data: { invalid: undefined },
        },
      ] as never),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    await expect(
      store.append(sessionId, [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          data: { invalid: Number.POSITIVE_INFINITY },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    await expect(stat(store.getFilePath(sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects invalid and future cursors', async () => {
    const sessionId = SessionId('session-cursor');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    await expect(store.read(sessionId, { after: EventSequence(2) })).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_CURSOR',
    });
    await expect(store.read(sessionId, { limit: 0 })).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_CURSOR',
    });
  });

  it('isolates session files and keeps encoded IDs within the store directory', async () => {
    const firstSession = SessionId('../../first/session');
    const secondSession = SessionId('second-session');
    await store.append(firstSession, [
      { type: DurableEventType.SESSION_CREATED, data: { session: 'first' } },
    ]);
    await store.append(secondSession, [
      { type: DurableEventType.SESSION_CREATED, data: { session: 'second' } },
    ]);

    expect(resolve(dirname(store.getFilePath(firstSession)))).toBe(
      resolve(storageRoot, 'durable-events'),
    );
    expect(store.getFilePath(firstSession)).not.toBe(store.getFilePath(secondSession));
    expect((await store.read(firstSession)).events[0]?.data).toEqual({
      session: 'first',
    });
    expect((await store.read(secondSession)).events[0]?.data).toEqual({
      session: 'second',
    });
  });

  it('returns defensive copies of appended and loaded event data', async () => {
    const sessionId = SessionId('session-clones');
    const data = { nested: { value: 'original' } };
    const appended = await store.append(sessionId, [
      { type: DurableEventType.SESSION_CREATED, data },
    ]);

    data.nested.value = 'mutated-input';
    (appended.events[0]?.data.nested as { value: string }).value = 'mutated-result';

    expect((await store.read(sessionId)).events[0]?.data).toEqual({
      nested: { value: 'original' },
    });
  });

  it('persists files with owner-only permissions', async () => {
    const sessionId = SessionId('session-permissions');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    const mode = (await stat(store.getFilePath(sessionId))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
