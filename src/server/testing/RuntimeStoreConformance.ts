import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
} from '../../protocol/index.js';
import {
  InputId,
  RequestId,
  SessionId,
} from '../../types/branded.js';
import type { RuntimeStore } from '../RuntimeStore.js';

export interface RuntimeStoreConformanceOptions {
  readonly tenantId?: string;
  readonly otherTenantId?: string;
  readonly idPrefix?: string;
}

export interface RuntimeStoreConformanceResult {
  readonly checks: readonly string[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`RuntimeStore conformance failed: ${message}`);
  }
}

/**
 * Executes the public RuntimeStore contract without depending on a test
 * framework. Run it against a dedicated database/schema because it writes data.
 */
export async function assertRuntimeStoreConformance(
  store: RuntimeStore,
  options: RuntimeStoreConformanceOptions = {},
): Promise<RuntimeStoreConformanceResult> {
  const suffix = options.idPrefix ?? `${Date.now()}-${Math.random()}`;
  const tenantId = options.tenantId ?? `tenant-${suffix}`;
  const otherTenantId = options.otherTenantId ?? `other-${suffix}`;
  const sessionId = SessionId(`session-${suffix}`);
  const checks: string[] = [];

  await store.initialize();
  const health = await store.healthCheck();
  assert(health.ready, 'healthCheck must report ready after initialize');
  checks.push('health');

  const sessions = store.forTenant(tenantId);
  await sessions.createSession(sessionId);
  await sessions.saveMessage(sessionId, 'user', 'hello');
  const tool = await sessions.saveToolUse(
    sessionId,
    'Search',
    { query: 'blade' },
  );
  await sessions.saveToolResult(
    sessionId,
    tool.toolCallId,
    'Search',
    { matches: 1 },
    tool.messageId,
  );
  await sessions.saveCompaction(
    sessionId,
    'summary',
    { trigger: 'manual', preTokens: 100, postTokens: 20 },
  );
  await sessions.saveInputEnqueued(sessionId, {
    inputId: InputId(`input-${suffix}`),
    content: 'queued',
    priority: 'later',
    acceptedAt: 1,
  });
  const state = await sessions.loadState(sessionId);
  assert(state?.summary === 'summary', 'Session projection must include summary');
  assert(state.messages.length === 4, 'Session projection must include all messages');
  assert(state.pendingInputs.length === 1, 'Session projection must include pending input');
  const pendingInputId = state.pendingInputs[0]?.inputId;
  assert(pendingInputId !== undefined, 'Pending input must expose its ID');
  await sessions.saveAppliedInputMessage(
    sessionId,
    pendingInputId,
    RequestId(`request-applied-${suffix}`),
    'queued',
  );
  await sessions.saveInputEnqueued(sessionId, {
    inputId: InputId(`cancel-${suffix}`),
    content: 'cancel',
    priority: 'later',
    acceptedAt: 2,
  });
  await sessions.saveInputCancelled(
    sessionId,
    InputId(`cancel-${suffix}`),
    'conformance',
  );
  const updatedState = await sessions.loadState(sessionId);
  assert(
    updatedState?.pendingInputs.length === 0,
    'Applied and cancelled inputs must leave no pending projection',
  );
  assert(
    (await sessions.loadMessages(sessionId)).length === 5,
    'Message projection must include the applied input',
  );
  assert(
    (await sessions.forkState(sessionId))?.messageIds.length === 5,
    'Fork projection must preserve the message timeline',
  );
  assert(
    (await sessions.getSessionSummary(sessionId))?.messageCount === 3,
    'Session summary must count user and assistant messages',
  );
  assert(
    (await sessions.listSessions()).includes(sessionId),
    'Session list must include the projected Session',
  );
  assert(
    (await sessions.getStorageStats()).totalSessions >= 1,
    'Session storage stats must include projected Sessions',
  );
  assert(
    await store.forTenant(otherTenantId).loadState(sessionId) === null,
    'Session projections must be tenant isolated',
  );
  const deleteSessionId = SessionId(`delete-${suffix}`);
  await sessions.createSession(deleteSessionId);
  await sessions.deleteSession(deleteSessionId);
  assert(
    await sessions.loadState(deleteSessionId) === null,
    'Deleted Session projection must not remain readable',
  );
  checks.push('session-projection');

  const serverRecord = {
    tenantId,
    createdBy: 'conformance',
    sessionId,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.putSession(serverRecord);
  assert(
    (await store.getSession(tenantId, sessionId))?.sessionId === sessionId,
    'Server Session record must round-trip',
  );
  assert(
    await store.getSession(otherTenantId, sessionId) === null,
    'Server Session records must be tenant isolated',
  );
  checks.push('tenant-isolation');

  const commandId = `command-${suffix}`;
  const fingerprint = `fingerprint-${suffix}`;
  const claim = await store.claimCommand(tenantId, commandId, fingerprint, 1000);
  assert(claim.status === 'claimed', 'First command claim must succeed');
  if (claim.status !== 'claimed') {
    throw new Error('unreachable');
  }
  await store.sealCommand(tenantId, commandId, claim.leaseId);
  const commandResult = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commandId,
    ok: true as const,
    data: { accepted: true },
  };
  await store.completeCommand(
    tenantId,
    commandId,
    claim.leaseId,
    commandResult,
  );
  const replay = await store.claimCommand(
    tenantId,
    commandId,
    fingerprint,
    1000,
  );
  assert(
    replay.status === 'completed'
    && JSON.stringify(replay.result) === JSON.stringify(commandResult),
    'Completed command must replay its deterministic result',
  );
  assert(
    (await store.claimCommand(
      tenantId,
      commandId,
      `${fingerprint}-different`,
      1000,
    )).status === 'conflict',
    'A reused command ID with a different fingerprint must conflict',
  );
  checks.push('command-receipts');

  await store.appendEvent(tenantId, sessionId, {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    occurredAt: new Date().toISOString(),
    type: 'session.closed',
    data: { reason: 'conformance' },
  });
  const agentEvents = await store.readEvents(tenantId, sessionId);
  assert(
    agentEvents.events.length === 1
    && agentEvents.events[0]?.sequence === 1,
    'Agent event stream must be sequenced',
  );
  checks.push('agent-events');

  const durable = await sessions.append(
    sessionId,
    [{
      type: 'session_created',
      data: { source: 'create' },
    }],
    { expectedLastSequence: null },
  );
  assert(
    durable.lastSequence === 1
    && (await sessions.read(sessionId)).events.length === 1,
    'Durable event stream must support compare-and-append',
  );
  checks.push('durable-events');

  const transactionCommandId = `transaction-${suffix}`;
  const transaction = {
    tenantId,
    sessionId,
    command: {
      commandId: transactionCommandId,
      fingerprint: `fingerprint-${transactionCommandId}`,
      result: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: transactionCommandId,
        ok: true as const,
        data: { committed: true },
      },
    },
    expectedLastSequence: null,
    events: [{
      type: 'request.accepted',
      data: { requestId: RequestId(`request-${suffix}`) },
    }],
    effects: [{
      effectId: `effect-${suffix}`,
      type: 'tool.execute',
      payload: { toolName: 'Search' },
      idempotencyKey: `effect-key-${suffix}`,
    }],
    projection: {
      name: 'conformance',
      expectedOffset: null,
      offset: 1,
      state: { status: 'accepted' },
    },
  };
  const committed = await store.commitRuntimeTransaction(transaction);
  assert(committed.status === 'committed', 'Runtime transaction must commit');
  assert(committed.events.length === 1, 'Runtime transaction must append events');
  assert(committed.effects.length === 1, 'Runtime transaction must enqueue effects');
  assert(
    committed.projection?.offset === 1,
    'Runtime transaction must checkpoint its projection',
  );
  const replayed = await store.commitRuntimeTransaction(transaction);
  assert(replayed.status === 'replayed', 'Runtime transaction retry must replay');
  assert(
    (await store.readDomainEvents(tenantId, sessionId)).events.length === 1,
    'Runtime transaction retry must not duplicate events',
  );
  checks.push('atomic-runtime-commit');

  const rollbackCommandId = `rollback-${suffix}`;
  let rejected = false;
  try {
    await store.commitRuntimeTransaction({
      tenantId,
      sessionId,
      command: {
        commandId: rollbackCommandId,
        fingerprint: `fingerprint-${rollbackCommandId}`,
        result: {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          commandId: rollbackCommandId,
          ok: true,
          data: {},
        },
      },
      expectedLastSequence: 999,
      events: [{ type: 'must.rollback', data: {} }],
      effects: [{
        effectId: `rollback-effect-${suffix}`,
        type: 'must.rollback',
        payload: {},
        idempotencyKey: `rollback-key-${suffix}`,
      }],
    });
  } catch {
    rejected = true;
  }
  assert(rejected, 'Conflicting runtime transaction must reject');
  assert(
    (await store.readDomainEvents(tenantId, sessionId)).events.length === 1,
    'Rejected transaction must not append domain events',
  );
  assert(
    (await store.listEffects(tenantId)).length === 1,
    'Rejected transaction must not enqueue effects',
  );
  assert(
    (await store.claimCommand(
      tenantId,
      rollbackCommandId,
      `fingerprint-${rollbackCommandId}`,
      1000,
    )).status === 'claimed',
    'Rejected transaction must roll back its command receipt',
  );
  checks.push('transaction-rollback');

  assert(
    (await store.getProjection(
      tenantId,
      sessionId,
      'conformance',
    ))?.state.status === 'accepted',
    'Projection state must be readable at its committed offset',
  );
  checks.push('projection-checkpoint');

  assert(
    Object.values(AgentCommandType).length > 0,
    'Protocol command catalog must be available',
  );
  return { checks };
}
