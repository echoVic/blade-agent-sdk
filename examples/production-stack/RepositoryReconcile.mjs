import { SessionId } from '@blade-ai/agent-sdk/core';

/**
 * Startup reconciliation for the two windows a lease-based recovery scan cannot see.
 *
 * Both are cases where a durable fact was committed and the step that consumes it
 * never ran, so the route looks settled and nothing picks the work up:
 *
 * - A submission was accepted into the Session journal but never enqueued.
 * - A terminal result was recorded but never published to the event log.
 *
 * Running this on every launcher start makes both windows self-healing.
 *
 * Enqueueing is idempotent: a Session already queued is left alone. Republishing
 * is made safe by recognising the outcome in the log before appending it again,
 * because the event store assigns its own event identity and cannot deduplicate on
 * the caller's behalf.
 */
export async function reconcilePendingWork({ store, state, tenantId, publish, report = () => {} }) {
  const reconciled = { enqueuedSubmissions: 0, republishedOutcomes: 0, alreadyPublished: 0 };

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

  for (const outcome of await state.listUnpublishedOutcomes()) {
    const sessionId = SessionId(outcome.sessionId);
    const expected = outcome.event?.data;
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

  return reconciled;
}

/**
 * Whether the terminal result for this Request is already in the log. Matching on
 * the outcome's own fields keeps this independent of the event identity the store
 * assigns.
 */
async function hasPublishedOutcome(store, tenantId, sessionId, requestId, expected) {
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
