import { AGENT_PROTOCOL_VERSION, type AgentEventPage } from '../../protocol/index.js';
import type {
  AgentCommandClaim,
  AgentServerSessionRecord,
  AgentServerStore,
} from '../AgentServerStore.js';
import { CommandId, RequestId, SessionId } from '../../types/identifiers.js';

/**
 * Shared contract for every `AgentServerStore`.
 *
 * The recovery guarantee of `session.read` and the idempotency guarantee of
 * `appendEvent` are properties of the *store*, not of one implementation: a second
 * implementation that quietly differs turns those guarantees into a lie. Any store
 * shipped with the SDK, and any store a host writes, is expected to pass this.
 */
export interface AgentServerStoreConformanceOptions {
  /** Makes the tenant and session identifiers unique per run. */
  readonly idPrefix?: string;
}

export interface AgentServerStoreConformanceResult {
  readonly checks: readonly string[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`AgentServerStore conformance failed: ${message}`);
  }
}

function scopedId(prefix: string, suffix: string): string {
  return `${prefix}-${suffix}`;
}

/**
 * A committed terminal event, used for every idempotency check.
 */
function terminalDraft(sessionId: SessionId, content: string) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    requestId: RequestId(`request-${content}`),
    occurredAt: new Date().toISOString(),
    type: 'session.stream' as const,
    data: { type: 'result', subtype: 'success', content, sessionId },
  };
}

export async function assertAgentServerStoreConformance(
  store: AgentServerStore,
  options: AgentServerStoreConformanceOptions = {},
): Promise<AgentServerStoreConformanceResult> {
  const prefix = options.idPrefix ?? `store-${Date.now()}`;
  const checks: string[] = [];
  const tenantId = scopedId(prefix, 'tenant');
  const otherTenantId = scopedId(prefix, 'tenant-other');

  const sessionRecord = (
    sessionId: SessionId,
    tenant = tenantId,
    metadata: Record<string, string> = {},
  ): AgentServerSessionRecord => ({
    tenantId: tenant,
    sessionId,
    createdBy: 'conformance',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata,
  });

  const sessionId = SessionId(scopedId(prefix, 'session'));
  await store.putSession(sessionRecord(sessionId));
  await store.putSession(sessionRecord(sessionId, otherTenantId));
  assert(
    (await store.getSession(tenantId, sessionId))?.sessionId === sessionId,
    'A stored Session record must be readable by its tenant',
  );
  assert(
    (await store.getSession(otherTenantId, sessionId))?.tenantId === otherTenantId,
    'Session records must be isolated per tenant',
  );
  const listed = await store.listSessions(tenantId);
  assert(
    listed.sessions.every((record) => record.tenantId === tenantId) &&
      listed.sessions.some((record) => record.sessionId === sessionId),
    'Session listing must return the tenant records and nothing else',
  );
  checks.push('session-records');

  const commandId = CommandId(scopedId(prefix, 'command'));
  const fingerprint = scopedId(prefix, 'fingerprint');
  const claim = await store.claimCommand(tenantId, commandId, fingerprint, 1_000);
  assert(claim.status === 'claimed', 'The first claim of a command must succeed');
  const claimed = claim as Extract<AgentCommandClaim, { status: 'claimed' }>;
  await store.sealCommand(tenantId, commandId, claimed.leaseId);
  const result = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commandId,
    ok: true as const,
    data: { accepted: true },
  };
  await store.completeCommand(tenantId, commandId, claimed.leaseId, result);
  const replay = await store.claimCommand(tenantId, commandId, fingerprint, 1_000);
  assert(
    replay.status === 'completed' &&
      JSON.stringify(replay.result) === JSON.stringify(result),
    'A completed command must replay its recorded result',
  );
  assert(
    (await store.claimCommand(tenantId, commandId, `${fingerprint}-other`, 1_000)).status ===
      'conflict',
    'Reusing a command id with another fingerprint must conflict',
  );
  const abandonedId = CommandId(scopedId(prefix, 'command-abandoned'));
  const abandonedClaim = await store.claimCommand(
    tenantId,
    abandonedId,
    scopedId(prefix, 'fingerprint-abandoned'),
    1_000,
  );
  assert(abandonedClaim.status === 'claimed', 'A second command must be claimable');
  await store.sealCommand(
    tenantId,
    abandonedId,
    (abandonedClaim as Extract<AgentCommandClaim, { status: 'claimed' }>).leaseId,
  );
  assert(
    (await store.abandonCommand(tenantId, abandonedId, 'conformance')) === true,
    'A sealed command must be abandonable',
  );
  assert(
    (await store.claimCommand(tenantId, abandonedId, scopedId(prefix, 'fingerprint-abandoned'), 1_000))
      .status === 'abandoned',
    'An abandoned command must stay terminal',
  );
  checks.push('command-receipts');

  const first = await store.appendEvent(tenantId, sessionId, terminalDraft(sessionId, 'first'));
  const second = await store.appendEvent(tenantId, sessionId, terminalDraft(sessionId, 'second'));
  assert(
    second.sequence === first.sequence + 1,
    'Agent events must be sequenced in append order',
  );
  const read: AgentEventPage = await store.readEvents(tenantId, sessionId);
  assert(
    read.events.length === 2 && read.events[0]?.eventId === first.eventId,
    'Reading the agent stream must return the appended events in order',
  );
  assert(
    (await store.getLatestEventSequence?.(tenantId, sessionId)) === second.sequence,
    'The store must report the head of the agent stream',
  );
  const range = await store.getEventStreamRange?.(tenantId, sessionId);
  assert(
    range !== null &&
      range !== undefined &&
      range.firstSequence === first.sequence &&
      range.headSequence === second.sequence,
    'The store must report the retained range of the agent stream; a recovery cursor cannot be safe without it',
  );
  checks.push('agent-events');

  const scoped = await store.appendEvent(
    tenantId,
    sessionId,
    terminalDraft(sessionId, 'terminal'),
    { idempotencyKey: scopedId(prefix, 'terminal-key') },
  );
  const repeat = await store.appendEvent(
    tenantId,
    sessionId,
    terminalDraft(sessionId, 'terminal'),
    { idempotencyKey: scopedId(prefix, 'terminal-key') },
  );
  assert(
    repeat.eventId === scoped.eventId && repeat.sequence === scoped.sequence,
    'Repeating an idempotency key must return the stored event',
  );
  assert(
    (await store.getEventByIdempotencyKey?.(tenantId, sessionId, scopedId(prefix, 'terminal-key')))
      ?.eventId === scoped.eventId,
    'An idempotency key must be readable on its own',
  );
  // The interleaving this whole mechanism exists for: both publishers pass their own
  // "is it there yet?" read before either writes.
  const raceKey = scopedId(prefix, 'race-key');
  const raced = await Promise.all([
    store.appendEvent(tenantId, sessionId, terminalDraft(sessionId, 'raced'), {
      idempotencyKey: raceKey,
    }),
    store.appendEvent(tenantId, sessionId, terminalDraft(sessionId, 'raced'), {
      idempotencyKey: raceKey,
    }),
  ]);
  assert(
    raced[0]?.eventId === raced[1]?.eventId && raced[0]?.sequence === raced[1]?.sequence,
    'Concurrent appends under one idempotency key must resolve to the same event',
  );
  const afterRace = await store.readEvents(tenantId, sessionId, { limit: 1000 });
  assert(
    afterRace.events.filter((event) => event.eventId === raced[0]?.eventId).length === 1,
    'Concurrent appends under one idempotency key must store exactly one event',
  );
  assert(
    (await store.getEventByIdempotencyKey?.(
      tenantId,
      sessionId,
      scopedId(prefix, 'unknown-key'),
    )) === null,
    'An unknown idempotency key must resolve to null',
  );
  checks.push('idempotent-appends');

  return { checks };
}
