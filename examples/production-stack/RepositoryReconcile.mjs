import { projectDurableSession, SessionId } from '@blade-ai/agent-sdk/core';
import { publishTerminalOutcome } from './RepositoryTerminalOutcome.mjs';

const SETTLED_ROUTE_STATES = new Set(['idle', 'completed', 'failed']);
/** Bound on how much of one durable journal a single startup pass replays. */
const JOURNAL_PAGE_SIZE = 500;
const JOURNAL_PAGE_LIMIT = 100;
/**
 * How much of a journal that exceeds the replay budget is inspected at its end.
 * An accepted-but-unenqueued request is the journal's last event, so the tail
 * decides the recovery without replaying the whole history.
 */
const JOURNAL_TAIL_EVENTS = 50;

/**
 * Startup reconciliation for the windows a lease-based recovery scan cannot see.
 *
 * Durable facts that were committed but whose consuming step never ran:
 *
 * - A submission was accepted into the Session journal but never enqueued. The
 *   acceptance row covers the enqueue; when even that row was lost, the request
 *   is rebuilt from the durable journal projection, so no ordinary write after
 *   the committed input is required for integrity. The transcript projection is
 *   deliberately not consulted: `Session.send()` reports acceptance as soon as
 *   the journal commit lands, so a missing transcript write is exactly the case
 *   this sweep exists for.
 * - A terminal result was recorded but never published to the event log.
 *
 * Running this on every launcher start makes both windows self-healing.
 *
 * Outcome republish contract:
 *
 * - The Worker owns publishing while it holds the route. Reconciliation only
 *   republishes once the route is settled and the lease is released, so a client
 *   can never observe a final result while the next input would still be refused.
 * - The outcome is bound to the request and the route attempt that produced it;
 *   a settled route for a different request supersedes the old outcome instead of
 *   publishing it.
 * - Both the Worker's finalize and this reconciler publish under the terminal
 *   identity as the store's idempotency key, so concurrent publishers produce one
 *   event: the store serializes the appends and the second one is a no-op. Neither
 *   side reads the log first, which also keeps long Sessions from turning a
 *   publish into a full history scan.
 *
 * Enqueueing is idempotent: a Session already queued is left alone.
 */
export async function reconcilePendingWork({ store, state, tenantId, publish, report = () => {} }) {
  const reconciled = {
    enqueuedSubmissions: 0,
    republishedOutcomes: 0,
    supersededOutcomes: 0,
    alreadyPublished: 0,
  };

  await reconcileSubmissionRecords({ store, state, tenantId, publish, report, reconciled });
  await reconcileJournalInputs({ store, state, tenantId, report, reconciled });
  await reconcileOutcomes({ store, state, tenantId, publish, report, reconciled });

  return reconciled;
}

async function reconcileSubmissionRecords({ store, state, tenantId, publish, report, reconciled }) {
  for (const pending of await state.listPendingSubmissions()) {
    const sessionId = SessionId(pending.sessionId);
    const route = await store.getSessionRoute(tenantId, sessionId);
    // A Worker may already own the Session; the acceptance record looked pending
    // only because the confirming write was lost.
    if (route && route.state !== 'idle' && route.state !== 'queued') {
      await state.markSubmissionQueued(sessionId, pending.requestId);
      continue;
    }
    await store.enqueueSession(tenantId, sessionId, {
      metadata: {
        ...(route?.metadata ?? {}),
        bladeQueuedRequest: {
          version: 1,
          ...pending.value,
          acceptedAt: Date.now(),
          recoveredFrom: 'accepted_without_enqueue',
        },
      },
    });
    await state.markSubmissionQueued(sessionId, pending.requestId);
    reconciled.enqueuedSubmissions += 1;
    report({ type: 'reconciled_submission', sessionId: pending.sessionId, requestId: pending.requestId });
  }
}

/**
 * Rebuilds submissions whose acceptance record was never written.
 *
 * The durable Session journal is the authority for accepted input, so an
 * unfinished request on a route no Worker owns can only be a submission that
 * crashed between the journal commit and the acceptance record. The durable
 * projection is read here, never the transcript projection: a transcript write
 * that never happened would hide the very request this sweep has to recover.
 */
async function reconcileJournalInputs({ store, state, tenantId, report, reconciled }) {
  const tenantStore = store.forTenant(tenantId);
  let cursor;
  do {
    const page = await store.listSessions(tenantId, { ...(cursor ? { cursor } : {}), limit: 100 });
    for (const session of page.sessions) {
      if (session.status === 'closed') continue;
      const sessionId = SessionId(session.sessionId);
      const route = await store.getSessionRoute(tenantId, sessionId);
      if (route && route.state !== 'idle') continue;
      const request = await readActiveDurableRequest(tenantStore, sessionId, report);
      if (!request || typeof request.input !== 'string') continue;
      const requestId = request.requestId;
      // The route already carries this request, so it was enqueued and the
      // Worker consumed it; nothing to rebuild.
      if (route?.metadata?.bladeQueuedRequest?.requestId === requestId) continue;
      const value = {
        status: 'started',
        inputId: request.inputId,
        requestId,
        input: request.input,
      };
      // Record acceptance first so a crash between the rebuild steps is found
      // by the ordinary sweep on the next start.
      await state.recordSubmissionAccepted({
        sessionId,
        requestId,
        input: request.input,
        value,
      });
      await store.enqueueSession(tenantId, sessionId, {
        metadata: {
          ...(route?.metadata ?? {}),
          bladeQueuedRequest: {
            version: 1,
            ...value,
            acceptedAt: acceptedAtMs(request.acceptedAt),
            recoveredFrom: 'durable_journal',
          },
        },
      });
      await state.markSubmissionQueued(sessionId, requestId);
      reconciled.enqueuedSubmissions += 1;
      report({ type: 'reconciled_submission', sessionId, requestId, recoveredFrom: 'durable_journal' });
    }
    cursor = page.nextCursor;
  } while (cursor);
}

function acceptedAtMs(acceptedAt) {
  const parsed = typeof acceptedAt === 'string' ? Date.parse(acceptedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * The active request from the durable journal projection, or null when the
 * journal holds no unfinished request.
 *
 * A journal longer than the replay budget cannot be projected in one startup pass.
 * It does not have to be: the window this sweep recovers - accepted but never
 * enqueued - leaves the acceptance as the journal's *last* event, because nothing
 * runs until the request is enqueued. The tail is therefore decisive, and the
 * recovery no longer depends on how long the history is.
 */
async function readActiveDurableRequest(tenantStore, sessionId, report) {
  const events = [];
  let after;
  for (let page = 0; page < JOURNAL_PAGE_LIMIT; page += 1) {
    const read = await tenantStore.read(sessionId, {
      ...(after === undefined ? {} : { after }),
      limit: JOURNAL_PAGE_SIZE,
    });
    events.push(...read.events);
    if (!read.hasMore || read.nextCursor === null || read.nextCursor === undefined) {
      return projectDurableSession(events).activeRequest;
    }
    after = read.nextCursor;
  }

  const tail = await readDurableTail(tenantStore, sessionId);
  report({
    type: 'journal_scan_truncated',
    sessionId,
    inspectedTailEvents: tail.length,
    lastEventType: tail.at(-1)?.type ?? null,
  });
  return acceptedRequestAtTail(tail);
}

/**
 * The last durable events of a journal, without replaying the history.
 *
 * `getHeadSequence` is the durable store's own head accessor; the tenant adapter
 * exposes the durable read port directly, so there is no separate head method.
 */
async function readDurableTail(tenantStore, sessionId) {
  if (typeof tenantStore.getHeadSequence !== 'function') {
    // Fail loudly: a renamed or missing head accessor used to make the fallback
    // silently recover nothing, which is indistinguishable from "nothing to do".
    throw new Error(
      'The durable store does not expose getHeadSequence; cannot inspect the journal tail',
    );
  }
  const head = await tenantStore.getHeadSequence(sessionId);
  if (head === null || head === undefined) {
    return [];
  }
  const headSequence = Number(head);
  if (!Number.isSafeInteger(headSequence) || headSequence < 1) {
    return [];
  }
  const after = Math.max(0, headSequence - JOURNAL_TAIL_EVENTS);
  const page = await tenantStore.read(sessionId, {
    ...(after > 0 ? { after } : {}),
    limit: JOURNAL_TAIL_EVENTS,
  });
  return page.events;
}

/**
 * The request an unfinished journal tail represents, or null when the last durable
 * event is not an open acceptance.
 */
function acceptedRequestAtTail(events) {
  const last = events.at(-1);
  if (!last || last.type !== 'request_accepted') {
    return null;
  }
  const data = last.data ?? {};
  if (typeof data.input !== 'string' || typeof data.inputId !== 'string') {
    return null;
  }
  return {
    requestId: last.requestId,
    inputId: data.inputId,
    input: data.input,
    acceptedAt: last.occurredAt,
  };
}

async function reconcileOutcomes({ store, state, tenantId, publish, report, reconciled }) {
  for (const outcome of await state.listUnpublishedOutcomes()) {
    const sessionId = SessionId(outcome.sessionId);
    const expected = outcome.event?.data;
    const route = await store.getSessionRoute(tenantId, sessionId);
    // Publishing belongs to the route owner until it settles and releases the
    // lease. A final result published earlier would make the client observe a
    // finished request while the route still refuses the next input.
    if (!route || !SETTLED_ROUTE_STATES.has(route.state) || route.leaseId) {
      report({ type: 'outcome_awaiting_settlement', sessionId: outcome.sessionId, requestId: outcome.requestId });
      continue;
    }
    // The settled route moved on to another request: this outcome is for a
    // request the client has left behind, so it must never be published.
    if (route.metadata?.bladeQueuedRequest?.requestId !== outcome.requestId) {
      await state.markOutcomeSuperseded(sessionId, outcome.requestId);
      reconciled.supersededOutcomes += 1;
      report({ type: 'outcome_superseded', sessionId: outcome.sessionId, requestId: outcome.requestId });
      continue;
    }
    // The outcome must belong to the attempt that settled, not an earlier one.
    if (outcome.attempt !== null && outcome.attempt !== route.attempt) {
      report({ type: 'outcome_attempt_mismatch', sessionId: outcome.sessionId, requestId: outcome.requestId });
      continue;
    }
    let result;
    try {
      result = await publishTerminalOutcome({
        store,
        publish,
        tenantId,
        sessionId,
        requestId: outcome.requestId,
        attempt: outcome.attempt,
        data: expected,
      });
    } catch (error) {
      // Keep the record pending for the next start instead of dropping the outcome.
      report({
        type: 'outcome_republish_failed',
        sessionId: outcome.sessionId,
        requestId: outcome.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    await state.markOutcomePublished(sessionId, outcome.requestId);
    if (result.published) {
      reconciled.republishedOutcomes += 1;
      report({ type: 'reconciled_outcome', sessionId: outcome.sessionId, requestId: outcome.requestId });
    } else {
      // The publish committed and only the confirming write was lost.
      reconciled.alreadyPublished += 1;
      report({ type: 'outcome_already_published', sessionId: outcome.sessionId, requestId: outcome.requestId });
    }
  }
}
