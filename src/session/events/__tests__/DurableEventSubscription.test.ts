import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '../../../errors/AbortError.js';
import {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  RequestId,
  SessionId,
} from '../../../types/branded.js';
import type {
  DurableEventAppendOptions,
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventPage,
  DurableEventReadOptions,
} from '../types.js';
import {
  DURABLE_EVENT_CURSOR_VERSION,
  durableEventCursor,
  DurableEventSubscription,
  DurableEventSubscriptionError,
  type DurableEventSubscriptionMessage,
  parseDurableEventCursor,
} from '../DurableEventSubscription.js';
import type { DurableEventStore } from '../DurableEventStore.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DurableEventType } from '../types.js';

const sessionId = SessionId('subscription-session');
const requestId = RequestId('subscription-request');
const inputId = InputId('subscription-input');
const roots: string[] = [];

function createStore(): JsonlDurableEventStore {
  const root = mkdtempSync(join(tmpdir(), 'durable-event-subscription-'));
  roots.push(root);
  let eventId = 0;
  return new JsonlDurableEventStore(root, {
    clock: () => new Date('2026-08-22T12:00:00.000Z'),
    eventIdFactory: () => EventId(`subscription-event-${++eventId}`),
  });
}

async function appendClosedSession(store: DurableEventStore): Promise<void> {
  const journal = await DurableSessionJournal.open(store, sessionId);
  await journal.commit({
    commandId: CommandId('create'),
    events: [
      {
        type: DurableEventType.SESSION_CREATED,
        data: { source: 'create' },
      },
    ],
  });
  await journal.commit({
    commandId: CommandId('close'),
    events: [
      {
        type: DurableEventType.SESSION_CLOSED,
        data: { reason: 'shutdown' },
      },
    ],
  });
}

async function appendOpenRequest(store: DurableEventStore): Promise<void> {
  const journal = await DurableSessionJournal.open(store, sessionId);
  await journal.commit({
    commandId: CommandId('create'),
    events: [
      {
        type: DurableEventType.SESSION_CREATED,
        data: { source: 'create' },
      },
    ],
  });
  await journal.commit({
    commandId: CommandId('accept'),
    events: [
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        data: {
          inputId,
          input: 'run',
          priority: 'next',
        },
      },
    ],
  });
  await journal.commit({
    commandId: CommandId('start'),
    events: [
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        data: {
          inputId,
          priority: 'next',
        },
      },
      {
        type: DurableEventType.REQUEST_STARTED,
        requestId,
        data: {},
      },
    ],
  });
  await journal.commit({
    commandId: CommandId('interrupt'),
    events: [
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId,
        data: { reason: 'process_restart' },
      },
    ],
  });
  await journal.commit({
    commandId: CommandId('close'),
    events: [
      {
        type: DurableEventType.SESSION_CLOSED,
        data: { reason: 'shutdown' },
      },
    ],
  });
}

async function collect(
  subscription: DurableEventSubscription,
): Promise<DurableEventSubscriptionMessage[]> {
  const messages: DurableEventSubscriptionMessage[] = [];
  for await (const message of subscription) {
    messages.push(message);
  }
  return messages;
}

class CountingStore implements DurableEventStore {
  reads = 0;

  constructor(private readonly delegate: DurableEventStore) {}

  append(
    requestedSessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    return this.delegate.append(requestedSessionId, events, options);
  }

  read(
    requestedSessionId: SessionId,
    options?: DurableEventReadOptions,
  ): Promise<DurableEventPage> {
    this.reads += 1;
    return this.delegate.read(requestedSessionId, options);
  }

  getHeadSequence(requestedSessionId: SessionId): Promise<EventSequence | null> {
    return this.delegate.getHeadSequence(requestedSessionId);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableEventSubscription', () => {
  it('replays through a stable caught-up barrier and closes at session_closed', async () => {
    const store = createStore();
    await appendClosedSession(store);
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      pageSize: 1,
      follow: false,
    });

    const messages = await collect(subscription);

    expect(messages.map((message) => message.type)).toEqual(['event', 'event', 'caught_up']);
    expect(
      messages
        .filter((message) => message.type === 'event')
        .map((message) => [message.event.type, message.phase]),
    ).toEqual([
      [DurableEventType.SESSION_CREATED, 'replay'],
      [DurableEventType.SESSION_CLOSED, 'replay'],
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: 'caught_up',
      headSequence: EventSequence(2),
      cursor: {
        version: DURABLE_EVENT_CURSOR_VERSION,
        sequence: EventSequence(2),
        eventId: EventId('subscription-event-2'),
      },
    });
    expect(subscription.isClosed).toBe(true);
  });

  it('resumes exclusively from a validated cursor', async () => {
    const store = createStore();
    await appendClosedSession(store);
    const events = (await store.read(sessionId)).events;
    const first = events[0];
    if (!first) {
      throw new Error('Expected first event');
    }
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      after: durableEventCursor(first),
      follow: false,
    });

    const messages = await collect(subscription);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'event',
      event: {
        sequence: EventSequence(2),
        type: DurableEventType.SESSION_CLOSED,
      },
      phase: 'replay',
    });
    expect(messages[1]).toMatchObject({
      type: 'caught_up',
      headSequence: EventSequence(2),
    });
  });

  it('finishes immediately when reconnecting after session_closed', async () => {
    const store = createStore();
    await appendClosedSession(store);
    const closed = (await store.read(sessionId)).events.at(-1);
    if (!closed) {
      throw new Error('Expected session_closed event');
    }
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      after: durableEventCursor(closed),
    });

    await expect(subscription.next()).resolves.toMatchObject({
      value: {
        type: 'caught_up',
        cursor: {
          sequence: closed.sequence,
          eventId: closed.eventId,
        },
      },
      done: false,
    });
    await expect(subscription.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('delivers events appended after caught_up as live', async () => {
    const store = createStore();
    const journal = await DurableSessionJournal.open(store, sessionId);
    const created = await journal.commit({
      commandId: CommandId('create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    const anchor = created.events[0];
    if (!anchor) {
      throw new Error('Expected session_created event');
    }
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      after: durableEventCursor(anchor),
      pollIntervalMs: 1,
    });

    await expect(subscription.next()).resolves.toMatchObject({
      value: {
        type: 'caught_up',
        headSequence: EventSequence(1),
      },
      done: false,
    });
    const pending = subscription.next();
    await journal.commit({
      commandId: CommandId('close'),
      events: [
        {
          type: DurableEventType.SESSION_CLOSED,
          data: { reason: 'shutdown' },
        },
      ],
    });

    await expect(pending).resolves.toMatchObject({
      value: {
        type: 'event',
        phase: 'live',
        event: {
          type: DurableEventType.SESSION_CLOSED,
          sequence: EventSequence(2),
        },
      },
      done: false,
    });
    await expect(subscription.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('does not interleave live events ahead of the caught-up barrier', async () => {
    const store = createStore();
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      pollIntervalMs: 1,
    });
    await journal.commit({
      commandId: CommandId('close'),
      events: [
        {
          type: DurableEventType.SESSION_CLOSED,
          data: { reason: 'shutdown' },
        },
      ],
    });

    await expect(subscription.next()).resolves.toMatchObject({
      value: {
        type: 'event',
        phase: 'replay',
        event: { sequence: EventSequence(1) },
      },
    });
    await expect(subscription.next()).resolves.toMatchObject({
      value: {
        type: 'caught_up',
        headSequence: EventSequence(1),
      },
    });
    await expect(subscription.next()).resolves.toMatchObject({
      value: {
        type: 'event',
        phase: 'live',
        event: {
          sequence: EventSequence(2),
          type: DurableEventType.SESSION_CLOSED,
        },
      },
    });
    await expect(subscription.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('does not read ahead beyond the configured page buffer', async () => {
    const delegate = createStore();
    await appendOpenRequest(delegate);
    const store = new CountingStore(delegate);
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      pageSize: 2,
      follow: false,
    });

    await subscription.next();
    expect(store.reads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.reads).toBe(1);

    await subscription.next();
    expect(store.reads).toBe(1);
    await subscription.next();
    expect(store.reads).toBe(2);
    subscription.close();
  });

  it('serializes concurrent next calls without reordering events', async () => {
    const store = createStore();
    await appendClosedSession(store);
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      pageSize: 1,
      follow: false,
    });

    const messages = await Promise.all([
      subscription.next(),
      subscription.next(),
      subscription.next(),
      subscription.next(),
    ]);

    expect(messages.slice(0, 3).map((result) => result.value?.type)).toEqual([
      'event',
      'event',
      'caught_up',
    ]);
    expect(messages[3]).toEqual({ done: true, value: undefined });
  });

  it('rejects foreign, malformed, and stale cursors', async () => {
    const store = createStore();
    await appendClosedSession(store);
    const events = (await store.read(sessionId)).events;
    const first = events[0];
    if (!first) {
      throw new Error('Expected first event');
    }

    await expect(
      DurableEventSubscription.open(store, sessionId, {
        after: {
          ...durableEventCursor(first),
          sessionId: SessionId('other-session'),
        },
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
    });
    await expect(
      DurableEventSubscription.open(store, sessionId, {
        after: {
          ...durableEventCursor(first),
          eventId: EventId('rewritten-event'),
        },
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
    });
    expect(() =>
      parseDurableEventCursor({
        version: DURABLE_EVENT_CURSOR_VERSION,
        sessionId,
        sequence: 0,
        eventId: first.eventId,
      }),
    ).toThrow(DurableEventSubscriptionError);
  });

  it.each([
    { pageSize: 0 },
    { pageSize: 1001 },
    { pollIntervalMs: 0 },
    { pollIntervalMs: 60_001 },
  ])('rejects invalid options %#', async (options) => {
    await expect(
      DurableEventSubscription.open(createStore(), sessionId, options),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS',
    });
  });

  it('aborts a pending live read and removes its abort listener', async () => {
    const store = createStore();
    const journal = await DurableSessionJournal.open(store, sessionId);
    const created = await journal.commit({
      commandId: CommandId('create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    const anchor = created.events[0];
    if (!anchor) {
      throw new Error('Expected session_created event');
    }
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      after: durableEventCursor(anchor),
      pollIntervalMs: 60_000,
      signal: controller.signal,
    });
    await subscription.next();
    const pending = subscription.next();
    await vi.waitFor(() => {
      expect(addListener).toHaveBeenCalled();
    });

    controller.abort('disconnect');

    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(removeListener).toHaveBeenCalled();
    expect(subscription.isClosed).toBe(true);
  });

  it('explicitly closes and unblocks a pending live read', async () => {
    const store = createStore();
    const journal = await DurableSessionJournal.open(store, sessionId);
    const created = await journal.commit({
      commandId: CommandId('create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    const anchor = created.events[0];
    if (!anchor) {
      throw new Error('Expected session_created event');
    }
    const subscription = await DurableEventSubscription.open(store, sessionId, {
      after: durableEventCursor(anchor),
      pollIntervalMs: 60_000,
    });
    await subscription.next();
    const pending = subscription.next();

    subscription.close();

    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('does not deliver a page that resolves after close', async () => {
    const delegate = createStore();
    await appendClosedSession(delegate);
    const page = await delegate.read(sessionId);
    let resolveRead: ((value: DurableEventPage) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<DurableEventPage>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const delayedStore: DurableEventStore = {
      append: (...args) => delegate.append(...args),
      read,
      getHeadSequence: async () => page.headSequence,
    };
    const subscription = await DurableEventSubscription.open(delayedStore, sessionId);
    const pending = subscription.next();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });

    subscription.close();
    resolveRead?.(page);

    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('rejects malformed events returned by a Store', async () => {
    const delegate = createStore();
    await appendClosedSession(delegate);
    const page = await delegate.read(sessionId);
    const malformedStore: DurableEventStore = {
      append: (...args) => delegate.append(...args),
      getHeadSequence: (requestedSessionId) => delegate.getHeadSequence(requestedSessionId),
      async read() {
        return {
          ...page,
          events: [
            {
              ...page.events[0],
              schemaVersion: 999,
            },
          ] as unknown as DurableEventPage['events'],
          headSequence: EventSequence(1),
          nextCursor: EventSequence(1),
          hasMore: false,
        };
      },
    };
    const subscription = await DurableEventSubscription.open(malformedStore, sessionId, {
      follow: false,
    });

    await expect(subscription.next()).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
    });
  });

  it('rejects a Store page that exceeds the configured buffer bound', async () => {
    const delegate = createStore();
    await appendClosedSession(delegate);
    const page = await delegate.read(sessionId);
    const oversizedStore: DurableEventStore = {
      append: (...args) => delegate.append(...args),
      getHeadSequence: (requestedSessionId) =>
        delegate.getHeadSequence(requestedSessionId),
      async read() {
        return page;
      },
    };
    const subscription = await DurableEventSubscription.open(
      oversizedStore,
      sessionId,
      {
        pageSize: 1,
        follow: false,
      },
    );

    await expect(subscription.next()).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
    });
  });

  it('fails closed on a gap in a Store page', async () => {
    const delegate = createStore();
    await appendClosedSession(delegate);
    const events = (await delegate.read(sessionId)).events;
    const first = events[0];
    if (!first) {
      throw new Error('Expected first event');
    }
    const gapStore: DurableEventStore = {
      append: (...args) => delegate.append(...args),
      getHeadSequence: (requestedSessionId) => delegate.getHeadSequence(requestedSessionId),
      async read(requestedSessionId, options) {
        const page = await delegate.read(requestedSessionId, options);
        if (options?.after === undefined && page.events[0]) {
          return {
            ...page,
            events: [
              {
                ...page.events[0],
                sequence: EventSequence(2),
              },
            ],
            headSequence: EventSequence(2),
            nextCursor: EventSequence(2),
            hasMore: false,
          };
        }
        return page;
      },
    };
    const subscription = await DurableEventSubscription.open(gapStore, sessionId, {
      follow: false,
    });

    await expect(subscription.next()).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
    });
    expect(subscription.isClosed).toBe(true);
  });
});
