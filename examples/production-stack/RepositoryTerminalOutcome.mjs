/**
 * The durable identity of one terminal result.
 *
 * A request's terminal event is published by whoever gets there first: the
 * Worker's `finalize` right after the route settles, or the launcher's startup
 * reconciliation when the Worker died before it could. Both sides derive the same
 * key from the same recorded facts, so the store can make the second publish a
 * no-op instead of a duplicate — and no side has to scan the event log to find
 * out whether the other one already ran.
 */
export function terminalOutcomeEventKey(sessionId, requestId, attempt) {
  const identity = attempt === null || attempt === undefined ? 'unknown' : String(attempt);
  return `terminal-outcome:${sessionId}:${requestId}:${identity}`;
}

/**
 * Publish a terminal result at most once.
 *
 * Returns whether this call stored the event (`published`) or found it already
 * stored (`alreadyPublished`), so a reconciler can report what actually happened
 * without a read-then-append race.
 */
export async function publishTerminalOutcome({ store, publish, tenantId, sessionId, requestId, attempt, data }) {
  const idempotencyKey = terminalOutcomeEventKey(sessionId, requestId, attempt);
  const existing = await store.getEventByIdempotencyKey?.(tenantId, sessionId, idempotencyKey);
  await publish(tenantId, sessionId, 'session.stream', data, requestId, { idempotencyKey });
  return { idempotencyKey, published: !existing };
}
