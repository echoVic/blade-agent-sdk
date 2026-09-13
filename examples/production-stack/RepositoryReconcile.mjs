import { SessionId } from '@blade-ai/agent-sdk/core';

const SETTLED_ROUTE_STATES = new Set(['idle', 'completed', 'failed']);

/**
 * Startup reconciliation for the windows a lease-based recovery scan cannot see.
 *
 * Durable facts that were committed but whose consuming step never ran:
 *
 * - A submission was accepted into the Session journal but never enqueued. The
 *   acceptance row covers the enqueue; when even that row was lost, the request
 *   is rebuilt from the journal's pending input, so no ordinary write after the
 *   committed input is required for integrity.
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
 * - Both the Worker's finalize and this reconciler check the event log before
 *   appending, because the store assigns its own event identity and cannot
 *   deduplicate on the caller's behalf. That leaves only the milliseconds between
 *   a settle and the finalize that immediately follows it as a theoretical
 *   double-append window.
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
 * Rebuilds submissions whose acceptance record was never written. The Session
 * journal is the authority for accepted input, so a pending input on a route no
 * Worker owns can only be a submission that crashed between the journal write and
 * the acceptance record.
 */
async function reconcileJournalInputs({ store, state, tenantId, report, reconciled }) {
  let cursor;
  do {
    const page = await store.listSessions(tenantId, { ...(cursor ? { cursor } : {}), limit: 100 });
    for (const session of page.sessions) {
      if (session.status === 'closed') continue;
      const sessionId = SessionId(session.sessionId);
      const route = await store.getSessionRoute(tenantId, sessionId);
      if (route && route.state !== 'idle') continue;
      const snapshot = await store.forTenant(tenantId).loadState(sessionId);
      if (!snapshot) continue;
      for (const pending of snapshot.pendingInputs ?? []) {
        const requestId = pending.targetRequestId;
        if (!requestId || typeof pending.content !== 'string') continue;
        // The route already carries this request, so it was enqueued and the
        // Worker consumed it; nothing to rebuild.
        if (route?.metadata?.bladeQueuedRequest?.requestId === requestId) continue;
        const value = {
          status: 'started',
          inputId: pending.inputId,
          requestId,
          input: pending.content,
        };
        // Record acceptance first so a crash between the rebuild steps is found
        // by the ordinary sweep on the next start.
        await state.recordSubmissionAccepted({
          sessionId,
          requestId,
          input: pending.content,
          value,
        });
        await store.enqueueSession(tenantId, sessionId, {
          metadata: {
            ...(route?.metadata ?? {}),
            bladeQueuedRequest: {
              version: 1,
              ...value,
              acceptedAt: pending.acceptedAt ?? Date.now(),
              recoveredFrom: 'session_journal',
            },
          },
        });
        await state.markSubmissionQueued(sessionId, requestId);
        reconciled.enqueuedSubmissions += 1;
        report({ type: 'reconciled_submission', sessionId, requestId, recoveredFrom: 'session_journal' });
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
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
    if (await hasPublishedOutcome(store, tenantId, sessionId, outcome.requestId, expected)) {
      // The publish committed and only the confirming write was lost.
      await state.markOutcomePublished(sessionId, outcome.requestId);
      reconciled.alreadyPublished += 1;
      report({ type: 'outcome_already_published', sessionId: outcome.sessionId, requestId: outcome.requestId });
      continue;
    }
    try {
      await publish(tenantId, sessionId, 'session.stream', expected, outcome.requestId);
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
    reconciled.republishedOutcomes += 1;
    report({ type: 'reconciled_outcome', sessionId: outcome.sessionId, requestId: outcome.requestId });
  }
}

/**
 * Whether the terminal result for this Request is already in the log. Matching on
 * the outcome's own fields keeps this independent of the event identity the store
 * assigns.
 */
export async function hasPublishedOutcome(store, tenantId, sessionId, requestId, expected) {
  if (!expected) {
    return false;
  }
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const read = await store.readEvents(tenantId, sessionId, { after, limit: 500 });
    const match = read.events.some((candidate) => candidate.requestId === requestId
      && candidate.type === 'session.stream'
      && isSameOutcome(candidate.data, expected));
    if (match) {
      return true;
    }
    const last = read.events.at(-1);
    if (!last || !read.hasMore) {
      return false;
    }
    after = Number(last.sequence);
  }
  throw new Error(`Event log for ${sessionId} is too large to reconcile in one pass`);
}

function isSameOutcome(published, expected) {
  if (!published || typeof published !== 'object') {
    return false;
  }
  return published.type === expected.type
    && published.subtype === expected.subtype
    && (published.error ?? null) === (expected.error ?? null)
    && (published.content ?? '') === (expected.content ?? '');
}
