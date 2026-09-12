import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../src/types/identifiers.js';
import { reconcilePendingWork } from '../../examples/production-stack/RepositoryReconcile.mjs';

/** Minimal Worker Runtime surface the reconciler uses, plus a tiny event log. */
function createWorkerStore({ routes = new Map(), events = new Map() } = {}) {
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
  };
}

const tenantId = 'tenant-reconcile';

function createState({ submissions = [], outcomes = [] } = {}) {
  const pendingSubmissions = [...submissions];
  const unpublishedOutcomes = [...outcomes];
  const queued = [];
  const published = [];
  return {
    queued,
    published,
    // Mirrors RepositoryState: the accepted input is flattened into `value`.
    listPendingSubmissions: async () => pendingSubmissions
      .slice()
      .map((entry) => ({ ...entry, value: { ...entry.value, input: entry.input } })),
    markSubmissionQueued: async (sessionId, requestId) => {
      queued.push({ sessionId, requestId });
      const index = pendingSubmissions.findIndex((entry) => entry.requestId === requestId);
      if (index !== -1) pendingSubmissions.splice(index, 1);
    },
    listUnpublishedOutcomes: async () => unpublishedOutcomes.slice(),
    markOutcomePublished: async (sessionId, requestId) => {
      published.push({ sessionId, requestId });
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
      routes: new Map([[String(sessionId), { tenantId, sessionId, state: 'running', metadata: {} }]]),
    });
    const state = createState({
      submissions: [{ sessionId, requestId: 'request-owned', input: 'x', value: {} }],
    });

    const result = await reconcilePendingWork({ store, state, tenantId, publish: vi.fn() });

    expect(result.enqueuedSubmissions).toBe(0);
    expect(state.queued).toEqual([{ sessionId, requestId: 'request-owned' }]);
  });

  it('republishes a terminal result that was recorded but never published', async () => {
    const store = createWorkerStore();
    const sessionId = SessionId('session-outcome-pending');
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-2', event: { data: outcome } }],
    });
    const publish = vi.fn(async () => undefined);

    const result = await reconcilePendingWork({ store, state, tenantId, publish });

    expect(result.republishedOutcomes).toBe(1);
    expect(publish).toHaveBeenCalledWith(tenantId, sessionId, 'session.stream', outcome, 'request-2');
    expect(state.published).toEqual([{ sessionId, requestId: 'request-2' }]);
  });

  it('does not publish a second copy when the result is already in the log', async () => {
    const outcome = { type: 'result', subtype: 'success', content: 'done' };
    const sessionId = SessionId('session-outcome-published');
    const store = createWorkerStore({
      events: new Map([[String(sessionId), [{
        protocolVersion: 1, sessionId, requestId: 'request-3', sequence: 1,
        occurredAt: new Date().toISOString(), type: 'session.stream', data: outcome,
      }]]]),
    });
    const state = createState({
      outcomes: [{ sessionId, requestId: 'request-3', event: { data: outcome } }],
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
    const state = createState({
      outcomes: [{
        sessionId, requestId: 'request-4',
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
