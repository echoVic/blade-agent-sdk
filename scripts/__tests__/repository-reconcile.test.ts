import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../src/types/identifiers.js';
import { reconcilePendingWork } from '../../examples/production-stack/RepositoryReconcile.mjs';

/** Minimal Worker Runtime surface the reconciler uses, plus a tiny event log. */
function createWorkerStore({
  routes = new Map(),
  events = new Map(),
  sessions = [],
  states = new Map(),
} = {}) {
  const enqueued = [];
  return {
    enqueued,
    routes,
    events,
    getSessionRoute: async (_tenantId, sessionId) => routes.get(String(sessionId)) ?? null,
    enqueueSession: async (_tenantId, sessionId, options = {}) => {
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
    readEvents: async (_tenantId, sessionId, { after = 0, limit = 500 } = {}) => {
      const all = events.get(String(sessionId)) ?? [];
      const page = all.filter((event) => Number(event.sequence) > after).slice(0, limit);
      return { events: page, hasMore: all.length > after + page.length, nextCursor: null };
    },
    listSessions: async (_tenantId, _options = {}) => ({ sessions }),
    forTenant: () => ({
      loadState: async (sessionId) => states.get(String(sessionId)) ?? null,
    }),
  };
}

const tenantId = 'tenant-reconcile';

function settledRoute(sessionId, requestId, extra = {}) {
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

function createState({ submissions = [], outcomes = [] } = {}) {
  const pendingSubmissions = [...submissions];
  const unpublishedOutcomes = [...outcomes];
  const queued = [];
  const published = [];
  const superseded = [];
  const accepted = [];
  return {
    queued,
    published,
    superseded,
    accepted,
    // Mirrors RepositoryState: the accepted input is flattened into `value`.
    listPendingSubmissions: async () => pendingSubmissions
      .slice()
      .map((entry) => ({ ...entry, value: { ...entry.value, input: entry.input } })),
    markSubmissionQueued: async (sessionId, requestId) => {
      queued.push({ sessionId, requestId });
      const index = pendingSubmissions.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) pendingSubmissions.splice(index, 1);
    },
    recordSubmissionAccepted: async (record) => {
      accepted.push(record);
    },
    listUnpublishedOutcomes: async () => unpublishedOutcomes.slice(),
    markOutcomePublished: async (sessionId, requestId) => {
      published.push({ sessionId, requestId });
      const index = unpublishedOutcomes.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) unpublishedOutcomes.splice(index, 1);
    },
    markOutcomeSuperseded: async (sessionId, requestId) => {
      superseded.push({ sessionId, requestId });
      const index = unpublishedOutcomes.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) unpublishedOutcomes.splice(index, 1);
    },
  };
}

describe('startup reconciliation', () => {
  it('enqueues a submission that was accepted but never handed to a Worker', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-accepted-without-enqueue');
    const state = createState({
      submissions: [{
        sessionId,
        requestId: 'request-1',
        input: 'Fix the greeting',
        value: { sessionId, requestId: 'request-1' },
      }],
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
      routes: new Map([[String(sessionId), {
        tenantId, sessionId, state: 'running', attempt: 1, leaseId: 'lease-1', metadata: {},
      }]]),
    });
    const state = createState({
      submissions: [{ sessionId, requestId: 'request-owned', input: 'x', value: {} }],
    });

    const result = await reconcilePendingWork({ store, state, tenantId, publish: vi.fn() });

    expect(result.enqueuedSubmissions).toBe(0);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-owned' }]);
  });

  it('rebuilds a submission whose acceptance record was never written from the journal', async () => {
    const sessionId = SessionId('session-journal-rebuild');
    const store = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      states: new Map([[String(sessionId), {
        sessionId,
        pendingInputs: [{
          inputId: 'input-journal',
          content: 'Fix the greeting',
          priority: 'next',
          targetRequestId: 'request-journal',
          acceptedAt: 123,
        }],
      }]]),
    });
    const state = createState();
    const reports = [];

    const result = await reconcilePendingWork({
      store, state, tenantId, publish: vi.fn(),
      report: (entry) => reports.push(entry),
    });

    expect(result.enqueuedSubmissions).toBe(1);
    expect(state.accepted).toEqual([expect.objectContaining({
      sessionId,
      requestId: 'request-journal',
      input: 'Fix the greeting',
    })]);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-journal' }]);
    const route = store.routes.get(String(sessionId));
    expect(route?.metadata?.bladeQueuedRequest).toMatchObject({
      requestId: 'request-journal',
      inputId: 'input-journal',
      input: 'Fix the greeting',
      recoveredFrom: 'session_journal',
    });
    expect(reports).toContainEqual(expect.objectContaining({
      type: 'reconciled_submission',
      sessionId,
      requestId: 'request-journal',
    }));
  });

  it('does not rebuild journal inputs a Worker owns or that were already enqueued', async () => {
    const sessionId = SessionId('session-journal-owned');
    const running = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      states: new Map([[String(sessionId), {
        sessionId,
        pendingInputs: [{ inputId: 'input-1', content: 'Fix the greeting', priority: 'next',
          targetRequestId: 'request-1', acceptedAt: 1 }],
      }]]),
      routes: new Map([[String(sessionId), {
        tenantId, sessionId, state: 'running', attempt: 1, leaseId: 'lease-1', metadata: {},
      }]]),
    });
    const idleMatching = createWorkerStore({
      sessions: [{ tenantId, sessionId, status: 'active' }],
      states: new Map([[String(sessionId), {
        sessionId,
        pendingInputs: [{ inputId: 'input-2', content: 'Fix the greeting', priority: 'next',
          targetRequestId: 'request-2', acceptedAt: 1 }],
      }]]),
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-2')]]),
    });

    for (const store of [running, idleMatching]) {
      const result = await reconcilePendingWork({
        store, state: createState(), tenantId, publish: vi.fn(),
      });
      expect(result.enqueuedSubmissions).toBe(0);
      expect(store.enqueued).toEqual([]);
    }
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
    expect(publish).toHaveBeenCalledWith(tenantId, sessionId, 'session.stream', outcome, 'request-2');
    expect(state.published).toEqual([{ sessionId, requestId: 'request-2' }]);
  });

  it('does not publish an outcome while the route is still active or leased', async () => {
    for (const route of [
      { state: 'running', attempt: 1, leaseId: 'lease-1' },
      { state: 'waiting_approval', attempt: 1, leaseId: 'lease-1' },
      { state: 'idle', attempt: 1, leaseId: 'lease-1' },
    ]) {
      const sessionId = SessionId(`session-outcome-active-${route.state}`);
      const store = createWorkerStore({
        routes: new Map([[String(sessionId), {
          tenantId, sessionId, metadata: { bladeQueuedRequest: { requestId: 'request-5' } }, ...route,
        }]]),
      });
      const state = createState({
        outcomes: [{ sessionId, requestId: 'request-5', attempt: 1,
          event: { data: { type: 'result', subtype: 'success', content: 'done' } } }],
      });
      const publish = vi.fn(async () => undefined);
      const reports = [];

      const result = await reconcilePendingWork({
        store, state, tenantId, publish,
        report: (entry) => reports.push(entry),
      });

      expect(result.republishedOutcomes).toBe(0);
      expect(publish).not.toHaveBeenCalled();
      expect(state.published).toEqual([]);
      // The record stays pending for the route owner or a later start.
      expect(await state.listUnpublishedOutcomes()).toHaveLength(1);
      expect(reports).toContainEqual(expect.objectContaining({ type: 'outcome_awaiting_settlement' }));
    }
  });

  it('supersedes an outcome whose route settled for a different request', async () => {
    const sessionId = SessionId('session-outcome-superseded');
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-newer')]]),
    });
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-old', attempt: 1,
        event: { data: { type: 'result', subtype: 'success', content: 'done' } } }],
    });
    const publish = vi.fn(async () => undefined);
    const reports = [];

    const result = await reconcilePendingWork({
      store, state, tenantId, publish,
      report: (entry) => reports.push(entry),
    });

    expect(result.supersededOutcomes).toBe(1);
    expect(result.republishedOutcomes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(state.superseded).toEqual([{ sessionId, requestId: 'request-old' }]);
    expect(reports).toContainEqual(expect.objectContaining({
      type: 'outcome_superseded',
      requestId: 'request-old',
    }));
  });

  it('refuses to republish an outcome recorded for a different attempt', async () => {
    const sessionId = SessionId('session-outcome-attempt-mismatch');
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-6', { attempt: 2 })]]),
    });
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-6', attempt: 1,
        event: { data: { type: 'result', subtype: 'success', content: 'done' } } }],
    });
    const publish = vi.fn(async () => undefined);
    const reports = [];

    const result = await reconcilePendingWork({
      store, state, tenantId, publish,
      report: (entry) => reports.push(entry),
    });

    expect(result.republishedOutcomes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(reports).toContainEqual(expect.objectContaining({ type: 'outcome_attempt_mismatch' }));
  });

  it('does not publish a second copy when the result is already in the log', async () => {
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    const sessionId = SessionId('session-outcome-published');
    const store = createWorkerStore({
      routes: new Map([[String(sessionId), settledRoute(sessionId, 'request-3')]]),
      events: new Map([[String(sessionId), [{
        protocolVersion: 1, sessionId, requestId: 'request-3', sequence: 1,
        occurredAt: new Date().toISOString(), type: 'session.stream', data: outcome,
      }]]]),
    });
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-3', attempt: 1, event: { data: outcome } }],
    });
    const publish = vi.fn(async () => undefined);

    const result = await reconcilePendingWork({ store, state, tenantId, publish });

    expect(result.alreadyPublished).toBe(1);
    expect(result.republishedOutcomes).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the record pending when republishing fails', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-outcome-failing');
    store.routes.set(String(sessionId), settledRoute(sessionId, 'request-4'));
    const state = createState({
      outcomes: [{
        sessionId, requestId: 'request-4', attempt: 1,
        event: { data: { type: 'result', subtype: 'success', content: 'done' } },
      }],
    });
    const reports = [];

    const result = await reconcilePendingWork({
      store, state, tenantId,
      publish: vi.fn(async () => { throw new Error('event log unavailable'); }),
      report: (entry) => reports.push(entry),
    });

    expect(result.republishedOutcomes).toBe(0);
    expect(state.published).toEqual([]);
    expect(reports).toContainEqual(expect.objectContaining({
      type: 'outcome_republish_failed',
      message: 'event log unavailable',
    }));
    // The next start retries it.
    expect(await state.listUnpublishedOutcomes()).toHaveLength(1);
  });
});
