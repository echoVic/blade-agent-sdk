import { describe, expect, it, vi } from 'vitest';
import { reconcilePendingWork } from '../../examples/production-stack/RepositoryReconcile.mjs';
import type { DurableEventStore } from '../../src/session/events/DurableEventStore.js';
import { SessionId } from '../../src/types/identifiers.js';

/**
 * Minimal Worker Runtime surface the reconciler uses, plus a tiny event log and a
 * durable journal. There is deliberately no transcript projection: the durable
 * journal is the authority, and a lost transcript write is the case the sweep
 * exists for.
 */
/**
 * The durable read port the reconciler uses. Typing the double against the SDK's
 * own `DurableEventStore` keeps the fake honest: renaming `getHeadSequence` or
 * `read` in the SDK breaks this file instead of silently disabling recovery.
 */
type DurableReadPort = Pick<DurableEventStore, 'read' | 'getHeadSequence'>;

type EventRecord = {
  [key: string]: unknown;
  sequence?: number;
};
type RouteRecord = {
  tenantId?: string;
  sessionId?: ReturnType<typeof SessionId>;
  state: string;
  attempt?: number;
  leaseId?: string | null;
  metadata: Record<string, unknown>;
};
type PendingSubmission = {
  sessionId: ReturnType<typeof SessionId>;
  requestId: string;
  input: string;
  value: Record<string, unknown>;
};
type PendingOutcome = {
  sessionId: ReturnType<typeof SessionId>;
  requestId: string;
  attempt: number | null;
  event: { data: Record<string, unknown> };
};
type Report = Record<string, unknown>;
type WorkerStore = {
  enqueued: Array<{ sessionId: ReturnType<typeof SessionId>; options: Record<string, unknown> }>;
  routes: Map<string, RouteRecord>;
  events: Map<string, EventRecord[]>;
  journals: Map<string, EventRecord[]>;
  keyedEvents: Map<string, EventRecord>;
  getSessionRoute: (
    tenantId: string,
    sessionId: ReturnType<typeof SessionId>,
  ) => Promise<RouteRecord | null>;
  enqueueSession: (
    tenantId: string,
    sessionId: ReturnType<typeof SessionId>,
    options?: { metadata?: Record<string, unknown> },
  ) => Promise<RouteRecord>;
  readEvents: (
    tenantId: string,
    sessionId: ReturnType<typeof SessionId>,
    options?: { after?: number; limit?: number },
  ) => Promise<{ events: EventRecord[]; hasMore: boolean; nextCursor: number | null }>;
  listSessions: (
    tenantId: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    sessions: Array<{ tenantId: string; sessionId: ReturnType<typeof SessionId>; status: string }>;
  }>;
  appendEvent: (
    tenantId: string,
    sessionId: ReturnType<typeof SessionId>,
    event: EventRecord,
    options?: { idempotencyKey?: string },
  ) => Promise<EventRecord>;
  getEventByIdempotencyKey: (
    tenantId: string,
    sessionId: ReturnType<typeof SessionId>,
    key: string,
  ) => Promise<EventRecord | null>;
  forTenant: (tenantId: string) => DurableReadPort & { loadState: () => Promise<never> };
};
type StateDouble = {
  queued: Array<{ sessionId: ReturnType<typeof SessionId>; requestId: string }>;
  published: Array<{ sessionId: ReturnType<typeof SessionId>; requestId: string }>;
  superseded: Array<{ sessionId: ReturnType<typeof SessionId>; requestId: string }>;
  accepted: Report[];
  listPendingSubmissions: () => Promise<PendingSubmission[]>;
  markSubmissionQueued: (
    sessionId: ReturnType<typeof SessionId>,
    requestId: string,
  ) => Promise<void>;
  recordSubmissionAccepted: (record: Report) => Promise<void>;
  listUnpublishedOutcomes: () => Promise<PendingOutcome[]>;
  markOutcomePublished: (
    sessionId: ReturnType<typeof SessionId>,
    requestId: string,
  ) => Promise<void>;
  markOutcomeSuperseded: (
    sessionId: ReturnType<typeof SessionId>,
    requestId: string,
  ) => Promise<void>;
};

function createDurablePort(journals: Map<string, EventRecord[]>): DurableReadPort {
  return {
    getHeadSequence: async (sessionId: ReturnType<typeof SessionId>) => {
      const all = journals.get(String(sessionId)) ?? [];
      return all.length === 0 ? null : (all.at(-1) as { sequence: number }).sequence;
    },
    read: async (
      sessionId: ReturnType<typeof SessionId>,
      { after, limit = 500 }: { after?: number; limit?: number } = {},
    ) => {
      const all = journals.get(String(sessionId)) ?? [];
      const remaining =
        after === undefined
          ? all
          : all.filter((event) => Number((event as { sequence: number }).sequence) > Number(after));
      const page = remaining.slice(0, limit);
      return {
        events: page,
        headSequence: all.length === 0 ? null : (all.at(-1) as { sequence: number }).sequence,
        nextCursor: (page.at(-1) as { sequence: number } | undefined)?.sequence ?? null,
        hasMore: remaining.length > page.length,
      };
    },
  } as unknown as DurableReadPort;
}

function createWorkerStore({
  routes = new Map(),
  events = new Map(),
  sessions = [],
  journals = new Map(),
}: {
  routes?: Map<string, RouteRecord>;
  events?: Map<string, EventRecord[]>;
  sessions?: Array<{ tenantId: string; sessionId: ReturnType<typeof SessionId>; status: string }>;
  journals?: Map<string, EventRecord[]>;
} = {}): WorkerStore {
  const enqueued: WorkerStore['enqueued'] = [];
  const keyedEvents = new Map<string, EventRecord>();
  return {
    enqueued,
    routes,
    events,
    journals,
    keyedEvents,
    getSessionRoute: async (_tenantId: string, sessionId: ReturnType<typeof SessionId>) =>
      routes.get(String(sessionId)) ?? null,
    enqueueSession: async (
      _tenantId: string,
      sessionId: ReturnType<typeof SessionId>,
      options: { metadata?: Record<string, unknown> } = {},
    ) => {
      const route = {
        tenantId: _tenantId,
        sessionId,
        state: 'queued',
        attempt: 1,
        leaseId: null,
        metadata: options.metadata ?? {},
      };
      routes.set(String(sessionId), route);
      enqueued.push({ sessionId, options });
      return route;
    },
    readEvents: async (
      _tenantId: string,
      sessionId: ReturnType<typeof SessionId>,
      { after = 0, limit = 500 }: { after?: number; limit?: number } = {},
    ) => {
      const all = events.get(String(sessionId)) ?? [];
      const page = all.filter((event) => Number(event.sequence) > after).slice(0, limit);
      return { events: page, hasMore: all.length > after + page.length, nextCursor: null };
    },
    listSessions: async (_tenantId: string, _options: Record<string, unknown> = {}) => ({
      sessions,
    }),
    appendEvent: async (
      _tenantId: string,
      sessionId: ReturnType<typeof SessionId>,
      event: EventRecord,
      options: { idempotencyKey?: string } = {},
    ) => {
      const key = options?.idempotencyKey;
      if (key !== undefined) {
        const existing = keyedEvents.get(`${String(sessionId)}:${key}`);
        if (existing) return existing;
      }
      const stored = {
        ...event,
        eventId: key ?? `event-${keyedEvents.size + 1}`,
        sequence: keyedEvents.size + 1,
      };
      if (key !== undefined) keyedEvents.set(`${String(sessionId)}:${key}`, stored);
      return stored;
    },
    getEventByIdempotencyKey: async (
      _tenantId: string,
      sessionId: ReturnType<typeof SessionId>,
      key: string,
    ) => keyedEvents.get(`${String(sessionId)}:${key}`) ?? null,
    forTenant: (_tenantId: string) => ({
      // The reconciler must read the durable journal: the transcript projection
      // can legitimately be missing the very input it has to recover.
      loadState: async () => {
        throw new Error('The reconciler must not read the transcript projection');
      },
      ...createDurablePort(journals),
    }),
  };
}

/** A durable journal that accepted one request and never applied it. */
function durableJournal(
  sessionId: string,
  {
    requestId,
    inputId,
    input,
    acceptedAt: _acceptedAt,
  }: { requestId: string; inputId: string; input: string; acceptedAt: string | null },
): EventRecord[] {
  const occurredAt = (sequence: number) =>
    new Date(1_700_000_000_000 + sequence * 1_000).toISOString();
  const envelope = (
    sequence: number,
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): EventRecord => ({
    schemaVersion: 4,
    eventId: `event-${sequence}`,
    sequence,
    sessionId,
    recordedAt: occurredAt(sequence),
    occurredAt: occurredAt(sequence),
    type,
    data,
    ...extra,
  });
  return [
    envelope(
      1,
      'session_created',
      { source: 'create' },
      {
        commandId: `command-create-${sessionId}`,
      },
    ),
    envelope(
      2,
      'request_accepted',
      {
        inputId,
        input,
        priority: 'next',
      },
      {
        requestId,
        commandId: `command-accept-${requestId}`,
      },
    ),
  ];
}

const tenantId = 'tenant-reconcile';

function settledRoute(
  sessionId: ReturnType<typeof SessionId>,
  requestId: string,
  extra: Partial<RouteRecord> = {},
): RouteRecord {
  return {
    tenantId,
    sessionId,
    state: 'idle',
    attempt: 1,
    leaseId: null,
    metadata: requestId ? { bladeQueuedRequest: { requestId } } : {},
    ...extra,
  };
}

function createState({
  submissions = [],
  outcomes = [],
}: {
  submissions?: PendingSubmission[];
  outcomes?: PendingOutcome[];
} = {}): StateDouble {
  const pendingSubmissions = [...submissions];
  const unpublishedOutcomes = [...outcomes];
  const queued: StateDouble['queued'] = [];
  const published: StateDouble['published'] = [];
  const superseded: StateDouble['superseded'] = [];
  const accepted: Report[] = [];
  return {
    queued,
    published,
    superseded,
    accepted,
    // Mirrors RepositoryState: the accepted input is flattened into `value`.
    listPendingSubmissions: async () =>
      pendingSubmissions
        .slice()
        .map((entry) => ({ ...entry, value: { ...entry.value, input: entry.input } })),
    markSubmissionQueued: async (sessionId: ReturnType<typeof SessionId>, requestId: string) => {
      queued.push({ sessionId, requestId });
      const index = pendingSubmissions.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) pendingSubmissions.splice(index, 1);
    },
    recordSubmissionAccepted: async (record: Report) => {
      accepted.push(record);
    },
    listUnpublishedOutcomes: async () => unpublishedOutcomes.slice(),
    markOutcomePublished: async (sessionId: ReturnType<typeof SessionId>, requestId: string) => {
      published.push({ sessionId, requestId });
      const index = unpublishedOutcomes.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) unpublishedOutcomes.splice(index, 1);
    },
    markOutcomeSuperseded: async (sessionId: ReturnType<typeof SessionId>, requestId: string) => {
      superseded.push({ sessionId, requestId });
      const index = unpublishedOutcomes.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) unpublishedOutcomes.splice(index, 1);
    },
  };
}

/** A journal whose history exceeds the replay budget, ending in one acceptance. */
function longDurableJournal(sessionId: string, requestId: string, inputId: string) {
  const events: EventRecord[] = [];
  for (let sequence = 1; sequence <= 50_001; sequence += 1) {
    events.push({
      schemaVersion: 4,
      eventId: `event-${sequence}`,
      sequence,
      sessionId,
      recordedAt: '2023-11-14T22:13:20.000Z',
      occurredAt: '2023-11-14T22:13:20.000Z',
      commandId: `command-${sequence}`,
      type: 'input_applied',
      requestId,
      data: { inputId },
    });
  }
  // Nothing runs until the request is enqueued, so an accepted-but-lost request is
  // the journal's last event - even in a history this long.
  events.push({
    schemaVersion: 4,
    eventId: 'event-accepted',
    sequence: 50_002,
    sessionId,
    recordedAt: '2023-11-14T22:13:21.000Z',
    occurredAt: '2023-11-14T22:13:21.000Z',
    requestId,
    commandId: `command-accept-${requestId}`,
    type: 'request_accepted',
    data: { inputId, input: 'Fix the greeting', priority: 'next' },
  });
  return events;
}

describe('durable read port contract', () => {
  it('mirrors the methods the real tenant adapter exposes', async () => {
    const { PostgresRuntimeStore } = await import('../../src/server/PostgresRuntimeStore.js');
    // No connection is used: this only inspects the public surface of the adapter
    // the reconciler is handed in production.
    const store = new PostgresRuntimeStore({
      pool: { query: async () => ({ rows: [] }) } as never,
      schema: 'interface_contract',
      tablePrefix: 'runtime',
    } as never);
    const adapter = store.forTenant('tenant-contract');
    const realMethods = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)));

    for (const method of Object.keys(createDurablePort(new Map()))) {
      expect(realMethods.has(method), `${method} must exist on the tenant adapter`).toBe(true);
    }
  });
});

describe('startup reconciliation', () => {
  it('enqueues a submission that was accepted but never handed to a Worker', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-accepted-without-enqueue');
    const state = createState({
      submissions: [
        {
          sessionId,
          requestId: 'request-1',
          input: 'Fix the greeting',
          value: { sessionId, requestId: 'request-1' },
        },
      ],
    });
    const publish = vi.fn(async () => undefined);

    const result = await reconcilePendingWork({ store, state, tenantId, publish });

    expect(result.enqueuedSubmissions).toBe(1);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-1' }]);
    const route = store.routes.get(String(sessionId));
    expect(route?.state).toBe('queued');
    expect(route?.metadata?.bladeQueuedRequest).toMatchObject({
      requestId: 'request-1',
      input: 'Fix the greeting',
      recoveredFrom: 'accepted_without_enqueue',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('leaves a submission alone when a Worker already owns the Session', async () => {
    const sessionId = SessionId('session-already-owned');
    const store = createWorkerStore({
      routes: new Map([
        [
          String(sessionId),
          {
            tenantId,
            sessionId,
            state: 'running',
            attempt: 1,
            leaseId: 'lease-1',
            metadata: {},
          },
        ],
      ]),
    });
    const state = createState({
      submissions: [{ sessionId, requestId: 'request-owned', input: 'x', value: {} }],
    });

    const result = await reconcilePendingWork({ store, state, tenantId, publish: vi.fn() });

    expect(result.enqueuedSubmissions).toBe(0);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-owned' }]);
  });

  it('rebuilds a submission the transcript projection never recorded', async () => {
    const sessionId = SessionId('session-journal-rebuild');
    // The durable journal accepted the request; no transcript projection exists
    // for this Session at all.
    const journal = durableJournal(sessionId, {
      requestId: 'request-journal',
      inputId: 'input-journal',
      input: 'Fix the greeting',
      acceptedAt: '2023-11-14T22:13:20.000Z',
    });
    const store = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      journals: new Map([[String(sessionId), journal]]),
    });
    const state = createState();
    const reports: Report[] = [];

    const result = await reconcilePendingWork({
      store,
      state,
      tenantId,
      publish: vi.fn(),
      report: ((entry: Report) => {
        reports.push(entry);
      }) as () => void,
    });

    expect(result.enqueuedSubmissions).toBe(1);
    expect(state.accepted).toEqual([
      expect.objectContaining({
        sessionId,
        requestId: 'request-journal',
        input: 'Fix the greeting',
      }),
    ]);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-journal' }]);
    const route = store.routes.get(String(sessionId));
    expect(route?.metadata?.bladeQueuedRequest).toMatchObject({
      requestId: 'request-journal',
      inputId: 'input-journal',
      input: 'Fix the greeting',
      recoveredFrom: 'durable_journal',
    });
    // The projection timestamps acceptance from the journal, not from a local clock.
    expect(
      (route?.metadata?.bladeQueuedRequest as { acceptedAt?: unknown } | undefined)?.acceptedAt,
    ).toBe(Date.parse(String(journal.at(-1)?.occurredAt)));
    expect(reports).toContainEqual(
      expect.objectContaining({
        type: 'reconciled_submission',
        sessionId,
        requestId: 'request-journal',
      }),
    );
  });

  it('does not rebuild journal inputs a Worker owns or that were already enqueued', async () => {
    const sessionId = SessionId('session-journal-owned');
    const running = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      journals: new Map([
        [
          String(sessionId),
          durableJournal(sessionId, {
            requestId: 'request-1',
            inputId: 'input-1',
            input: 'Fix the greeting',
            acceptedAt: null,
          }),
        ],
      ]),
      routes: new Map([
        [
          String(sessionId),
          {
            tenantId,
            sessionId,
            state: 'running',
            attempt: 1,
            leaseId: 'lease-1',
            metadata: {},
          },
        ],
      ]),
    });
    const idleMatching = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      journals: new Map([
        [
          String(sessionId),
          durableJournal(sessionId, {
            requestId: 'request-2',
            inputId: 'input-2',
            input: 'Fix the greeting',
            acceptedAt: null,
          }),
        ],
      ]),
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-2')]]),
    });

    for (const store of [running, idleMatching]) {
      const result = await reconcilePendingWork({
        store,
        state: createState(),
        tenantId,
        publish: vi.fn(),
      });
      expect(result.enqueuedSubmissions).toBe(0);
      expect(store.enqueued).toEqual([]);
    }
  });

  it('recovers an accepted request from a journal longer than the replay budget', async () => {
    const sessionId = SessionId('session-journal-long');
    const store = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      journals: new Map([
        [String(sessionId), longDurableJournal(sessionId, 'request-long', 'input-long')],
      ]),
    });
    const state = createState();
    const reports: Report[] = [];

    const result = await reconcilePendingWork({
      store,
      state,
      tenantId,
      publish: vi.fn(),
      report: ((entry: Report) => {
        reports.push(entry);
      }) as () => void,
    });

    // The truncated scan falls back to the tail, which is decisive, so the
    // request is recovered instead of being retried and truncated forever.
    expect(result.enqueuedSubmissions).toBe(1);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-long' }]);
    const route = store.routes.get(String(sessionId));
    expect(route?.metadata?.bladeQueuedRequest).toMatchObject({
      requestId: 'request-long',
      inputId: 'input-long',
      input: 'Fix the greeting',
      recoveredFrom: 'durable_journal',
    });
    expect(reports).toContainEqual(
      expect.objectContaining({
        type: 'journal_scan_truncated',
        lastEventType: 'request_accepted',
      }),
    );
  });

  it('does not rebuild a long journal whose tail is not an open acceptance', async () => {
    const sessionId = SessionId('session-journal-long-settled');
    const journal = longDurableJournal(sessionId, 'request-long', 'input-long');
    // The accepted request was applied after all: its acceptance is no longer the
    // last event, so there is nothing to recover.
    journal.push({
      schemaVersion: 4,
      eventId: 'event-applied',
      sequence: 50_003,
      sessionId,
      recordedAt: '2023-11-14T22:13:22.000Z',
      occurredAt: '2023-11-14T22:13:22.000Z',
      commandId: 'command-applied',
      type: 'input_applied',
      requestId: 'request-long',
      data: { inputId: 'input-long' },
    });
    const store = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      journals: new Map([[String(sessionId), journal]]),
    });

    const result = await reconcilePendingWork({
      store,
      state: createState(),
      tenantId,
      publish: vi.fn(),
    });

    expect(result.enqueuedSubmissions).toBe(0);
    expect(store.enqueued).toEqual([]);
  });

  it('republishes a terminal result after the route settled for the same request', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-outcome-pending');
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    store.routes.set(String(sessionId), settledRoute(sessionId, 'request-2'));
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-2', attempt: 1, event: { data: outcome } }],
    });
    const publish = vi.fn(async () => undefined);

    const result = await reconcilePendingWork({ store, state, tenantId, publish });

    expect(result.republishedOutcomes).toBe(1);
    expect(publish).toHaveBeenCalledWith(
      tenantId,
      sessionId,
      'session.stream',
      outcome,
      'request-2',
      { idempotencyKey: 'terminal-outcome:session-outcome-pending:request-2:1' },
    );
    expect(state.published).toEqual([{ sessionId, requestId: 'request-2' }]);
  });

  it('reports an outcome the Worker already published instead of publishing twice', async () => {
    const sessionId = SessionId('session-outcome-already-published');
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-2')]]),
    });
    // The Worker's finalize committed the event and died before recording that.
    await store.appendEvent(
      tenantId,
      sessionId,
      {
        protocolVersion: 1,
        sessionId,
        requestId: 'request-2',
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: outcome,
      },
      { idempotencyKey: 'terminal-outcome:session-outcome-already-published:request-2:1' },
    );
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-2', attempt: 1, event: { data: outcome } }],
    });
    const publish = vi.fn(async (_tenantId, targetSessionId, _type, data, requestId, options) =>
      store.appendEvent(
        tenantId,
        targetSessionId,
        {
          protocolVersion: 1,
          sessionId: targetSessionId,
          requestId,
          occurredAt: new Date().toISOString(),
          type: 'session.stream',
          data,
        },
        options,
      ),
    );

    const result = await reconcilePendingWork({ store, state, tenantId, publish });

    expect(result.alreadyPublished).toBe(1);
    expect(result.republishedOutcomes).toBe(0);
    expect(state.published).toEqual([{ sessionId, requestId: 'request-2' }]);
  });

  it('keeps exactly one terminal event when the Worker and the reconciler race', async () => {
    const sessionId = SessionId('session-outcome-race');
    const requestId = 'request-9';
    const attempt = 3;
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, requestId, { attempt })]]),
    });
    const state = createState({
      outcomes: [{ sessionId, requestId, attempt, event: { data: outcome } }],
    });
    const append = (options: { idempotencyKey: string }) =>
      store.appendEvent(
        tenantId,
        sessionId,
        {
          protocolVersion: 1,
          sessionId,
          requestId,
          occurredAt: new Date().toISOString(),
          type: 'session.stream',
          data: outcome,
        },
        options,
      );
    const publish = vi.fn(async (_tenantId, _targetSessionId, _type, _data, _requestId, options) =>
      append(options),
    );

    // The Worker's finalize and the reconciler publish without either observing
    // the other first: the store's idempotency key is what makes that safe.
    await Promise.all([
      reconcilePendingWork({ store, state, tenantId, publish }),
      append({ idempotencyKey: `terminal-outcome:${sessionId}:${requestId}:${attempt}` }),
    ]);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.keyedEvents.size).toBe(1);
    expect(state.published).toEqual([{ sessionId, requestId }]);
  });

  it('does not publish an outcome while the route is still active or leased', async () => {
    for (const route of [
      { state: 'running', attempt: 1, leaseId: 'lease-1' },
      { state: 'waiting_approval', attempt: 1, leaseId: 'lease-1' },
      { state: 'idle', attempt: 1, leaseId: 'lease-1' },
    ]) {
      const sessionId = SessionId(`session-outcome-active-${route.state}`);
      const store = createWorkerStore({
        routes: new Map([
          [
            String(sessionId),
            {
              tenantId,
              sessionId,
              metadata: { bladeQueuedRequest: { requestId: 'request-5' } },
              ...route,
            },
          ],
        ]),
      });
      const state = createState({
        outcomes: [
          {
            sessionId,
            requestId: 'request-5',
            attempt: 1,
            event: { data: { type: 'result', subtype: 'success', content: 'done' } },
          },
        ],
      });
      const publish = vi.fn(async () => undefined);
      const reports: Report[] = [];

      const result = await reconcilePendingWork({
        store,
        state,
        tenantId,
        publish,
        report: ((entry: Report) => {
          reports.push(entry);
        }) as () => void,
      });

      expect(result.republishedOutcomes).toBe(0);
      expect(publish).not.toHaveBeenCalled();
      expect(state.published).toEqual([]);
      // The record stays pending for the route owner or a later start.
      expect(await state.listUnpublishedOutcomes()).toHaveLength(1);
      expect(reports).toContainEqual(
        expect.objectContaining({ type: 'outcome_awaiting_settlement' }),
      );
    }
  });

  it('supersedes an outcome whose route settled for a different request', async () => {
    const sessionId = SessionId('session-outcome-superseded');
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-newer')]]),
    });
    const state = createState({
      outcomes: [
        {
          sessionId,
          requestId: 'request-old',
          attempt: 1,
          event: { data: { type: 'result', subtype: 'success', content: 'done' } },
        },
      ],
    });
    const publish = vi.fn(async () => undefined);
    const reports: Report[] = [];

    const result = await reconcilePendingWork({
      store,
      state,
      tenantId,
      publish,
      report: ((entry: Report) => {
        reports.push(entry);
      }) as () => void,
    });

    expect(result.supersededOutcomes).toBe(1);
    expect(result.republishedOutcomes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(state.superseded).toEqual([{ sessionId, requestId: 'request-old' }]);
    expect(reports).toContainEqual(
      expect.objectContaining({
        type: 'outcome_superseded',
        requestId: 'request-old',
      }),
    );
  });

  it('refuses to republish an outcome recorded for a different attempt', async () => {
    const sessionId = SessionId('session-outcome-attempt-mismatch');
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-6', { attempt: 2 })]]),
    });
    const state = createState({
      outcomes: [
        {
          sessionId,
          requestId: 'request-6',
          attempt: 1,
          event: { data: { type: 'result', subtype: 'success', content: 'done' } },
        },
      ],
    });
    const publish = vi.fn(async () => undefined);
    const reports: Report[] = [];

    const result = await reconcilePendingWork({
      store,
      state,
      tenantId,
      publish,
      report: ((entry: Report) => {
        reports.push(entry);
      }) as () => void,
    });

    expect(result.republishedOutcomes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(reports).toContainEqual(expect.objectContaining({ type: 'outcome_attempt_mismatch' }));
  });

  it('keeps the record pending when republishing fails', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-outcome-failing');
    store.routes.set(String(sessionId), settledRoute(sessionId, 'request-4'));
    const state = createState({
      outcomes: [
        {
          sessionId,
          requestId: 'request-4',
          attempt: 1,
          event: { data: { type: 'result', subtype: 'success', content: 'done' } },
        },
      ],
    });
    const reports: Report[] = [];

    const result = await reconcilePendingWork({
      store,
      state,
      tenantId,
      publish: vi.fn(async () => {
        throw new Error('event log unavailable');
      }),
      report: ((entry: Report) => {
        reports.push(entry);
      }) as () => void,
    });

    expect(result.republishedOutcomes).toBe(0);
    expect(state.published).toEqual([]);
    expect(reports).toContainEqual(
      expect.objectContaining({
        type: 'outcome_republish_failed',
        message: 'event log unavailable',
      }),
    );
    // The next start retries it.
    expect(await state.listUnpublishedOutcomes()).toHaveLength(1);
  });
});
