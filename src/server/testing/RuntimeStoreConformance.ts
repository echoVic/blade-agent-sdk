import { AGENT_PROTOCOL_VERSION, AgentCommandType } from '../../protocol/index.js';
import {
  CommandId,
  EventSequence,
  ExecutionLeaseId,
  InputId,
  RequestId,
  SessionId,
  WorkerId,
} from '../../types/identifiers.js';
import type { RuntimeStore } from '../RuntimeStore.js';
import { effectLease } from '../WorkerRuntime.js';

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
  const tool = await sessions.saveToolUse(sessionId, 'Search', { query: 'blade' });
  await sessions.saveToolResult(
    sessionId,
    tool.toolCallId,
    'Search',
    { matches: 1 },
    tool.messageId,
  );
  await sessions.saveCompaction(sessionId, 'summary', {
    trigger: 'manual',
    preTokens: 100,
    postTokens: 20,
  });
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
  await sessions.saveInputCancelled(sessionId, InputId(`cancel-${suffix}`), 'conformance');
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
    (await store.forTenant(otherTenantId).loadState(sessionId)) === null,
    'Session projections must be tenant isolated',
  );
  const deleteSessionId = SessionId(`delete-${suffix}`);
  await sessions.createSession(deleteSessionId);
  await sessions.deleteSession(deleteSessionId);
  assert(
    (await sessions.loadState(deleteSessionId)) === null,
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
    (await store.getSession(otherTenantId, sessionId)) === null,
    'Server Session records must be tenant isolated',
  );
  checks.push('tenant-isolation');

  const commandId = CommandId(`command-${suffix}`);
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
  await store.completeCommand(tenantId, commandId, claim.leaseId, commandResult);
  const replay = await store.claimCommand(tenantId, commandId, fingerprint, 1000);
  assert(
    replay.status === 'completed' &&
      JSON.stringify(replay.result) === JSON.stringify(commandResult),
    'Completed command must replay its deterministic result',
  );
  assert(
    (await store.claimCommand(tenantId, commandId, `${fingerprint}-different`, 1000)).status ===
      'conflict',
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
    agentEvents.events.length === 1 && agentEvents.events[0]?.sequence === 1,
    'Agent event stream must be sequenced',
  );
  checks.push('agent-events');

  const durable = await sessions.append(
    sessionId,
    [
      {
        type: 'session_created',
        data: { source: 'create' },
      },
    ],
    { expectedLastSequence: null },
  );
  assert(
    durable.lastSequence === 1 && (await sessions.read(sessionId)).events.length === 1,
    'Durable event stream must support compare-and-append',
  );
  checks.push('durable-events');

  const transactionCommandId = CommandId(`transaction-${suffix}`);
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
    events: [
      {
        type: 'request.accepted',
        data: { requestId: RequestId(`request-${suffix}`) },
      },
    ],
    effects: [
      {
        effectId: `effect-${suffix}`,
        type: 'tool.execute',
        payload: { toolName: 'Search' },
        idempotencyKey: `effect-key-${suffix}`,
      },
    ],
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
  assert(committed.projection?.offset === 1, 'Runtime transaction must checkpoint its projection');
  const replayed = await store.commitRuntimeTransaction(transaction);
  assert(replayed.status === 'replayed', 'Runtime transaction retry must replay');
  assert(
    (await store.readDomainEvents(tenantId, sessionId)).events.length === 1,
    'Runtime transaction retry must not duplicate events',
  );
  checks.push('atomic-runtime-commit');

  const rollbackCommandId = CommandId(`rollback-${suffix}`);
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
      expectedLastSequence: EventSequence(999),
      events: [{ type: 'must.rollback', data: {} }],
      effects: [
        {
          effectId: `rollback-effect-${suffix}`,
          type: 'must.rollback',
          payload: {},
          idempotencyKey: `rollback-key-${suffix}`,
        },
      ],
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
    (
      await store.claimCommand(
        tenantId,
        rollbackCommandId,
        `fingerprint-${rollbackCommandId}`,
        1000,
      )
    ).status === 'claimed',
    'Rejected transaction must roll back its command receipt',
  );
  checks.push('transaction-rollback');

  assert(
    (await store.getProjection(tenantId, sessionId, 'conformance'))?.state.status === 'accepted',
    'Projection state must be readable at its committed offset',
  );
  checks.push('projection-checkpoint');

  const workerTenantId = `worker-tenant-${suffix}`;
  const firstWorkerId = WorkerId(`worker-a-${suffix}`);
  const secondWorkerId = WorkerId(`worker-b-${suffix}`);
  const firstWorker = await store.registerWorker({
    workerId: firstWorkerId,
    capacity: 2,
    ttlMs: 10_000,
    metadata: { zone: 'a' },
  });
  assert(firstWorker.status === 'active', 'Registered worker must be active');
  const heartbeat = await store.heartbeatWorker(firstWorkerId, 10_000);
  assert(
    heartbeat.lastHeartbeatAt >= firstWorker.lastHeartbeatAt,
    'Worker heartbeat must advance its liveness record',
  );

  const routedSessionId = SessionId(`routed-${suffix}`);
  const queued = await store.enqueueSession(workerTenantId, routedSessionId, {
    priority: 10,
  });
  assert(queued.state === 'queued', 'Enqueued Session must enter queued');
  const firstClaim = await store.claimSession({
    tenantId: workerTenantId,
    ownerId: firstWorkerId,
    leaseId: ExecutionLeaseId(`lease-a-${suffix}`),
    ttlMs: 10_000,
  });
  assert(firstClaim !== null, 'Active worker must claim a queued Session');
  assert(
    firstClaim.route.state === 'provisioning',
    'Claimed Session must enter provisioning',
  );
  const workerSessions = store.forTenant(workerTenantId);
  assert(
    await workerSessions.requiresExecutionLease(routedSessionId),
    'Claimed Session must require an execution fence',
  );
  let missingFenceRejected = false;
  try {
    await workerSessions.append(
      routedSessionId,
      [{ type: 'session_created', data: { source: 'create' } }],
      { expectedLastSequence: null },
    );
  } catch {
    missingFenceRejected = true;
  }
  assert(missingFenceRejected, 'Fenced Session must reject an omitted fence');
  const workerJournal = await workerSessions.append(
    routedSessionId,
    [{ type: 'session_created', data: { source: 'create' } }],
    {
      expectedLastSequence: null,
      executionFence: firstClaim.lease,
    },
  );
  assert(
    workerJournal.lastSequence === 1,
    'Current Session fence must authorize durable appends',
  );
  const running = await store.transitionSession(
    workerTenantId,
    firstClaim.lease,
    { expectedState: 'provisioning', state: 'running' },
  );
  assert(running.state === 'running', 'Provisioned Session must enter running');
  const waiting = await store.transitionSession(
    workerTenantId,
    firstClaim.lease,
    { expectedState: 'running', state: 'waiting_approval' },
  );
  assert(
    waiting.state === 'waiting_approval',
    'Running Session must enter waiting_approval',
  );
  const suspended = await store.handoffSession(
    workerTenantId,
    firstClaim.lease,
    { reason: 'conformance-handoff' },
  );
  assert(suspended.state === 'suspended', 'Handoff must suspend the Session');
  assert(
    (await store.handoffSession(workerTenantId, firstClaim.lease)).state
      === 'suspended',
    'Completed handoff must be idempotent for the same fence',
  );

  await store.drainWorker(firstWorkerId);
  const failedSessionId = SessionId(`failed-${suffix}`);
  await store.enqueueSession(workerTenantId, failedSessionId);
  let drainingWorkerRejected = false;
  try {
    await store.claimSession({
      tenantId: workerTenantId,
      ownerId: firstWorkerId,
      leaseId: ExecutionLeaseId(`draining-${suffix}`),
      ttlMs: 10_000,
    });
  } catch {
    drainingWorkerRejected = true;
  }
  assert(
    drainingWorkerRejected,
    'Draining worker must not claim new Sessions',
  );

  await store.registerWorker({
    workerId: secondWorkerId,
    capacity: 4,
    ttlMs: 10_000,
  });
  const secondClaim = await store.claimSession({
    tenantId: workerTenantId,
    ownerId: secondWorkerId,
    leaseId: ExecutionLeaseId(`lease-b-${suffix}`),
    ttlMs: 10_000,
  });
  assert(
    secondClaim?.route.sessionId === routedSessionId
    && secondClaim.lease.fencingToken > firstClaim.lease.fencingToken,
    'Handoff successor must receive a higher fencing token',
  );
  let staleFenceRejected = false;
  try {
    await store.transitionSession(
      workerTenantId,
      firstClaim.lease,
      { expectedState: 'suspended', state: 'provisioning' },
    );
  } catch {
    staleFenceRejected = true;
  }
  assert(staleFenceRejected, 'Previous worker fence must be rejected');
  let staleAppendRejected = false;
  try {
    await workerSessions.append(
      routedSessionId,
      [{ type: 'session_closed', data: { reason: 'error' } }],
      {
        expectedLastSequence: workerJournal.lastSequence,
        executionFence: firstClaim.lease,
      },
    );
  } catch {
    staleAppendRejected = true;
  }
  assert(staleAppendRejected, 'Previous fence must not append durable events');
  if (!secondClaim) {
    throw new Error('unreachable');
  }
  await store.transitionSession(
    workerTenantId,
    secondClaim.lease,
    { expectedState: 'provisioning', state: 'running' },
  );
  const completed = await store.transitionSession(
    workerTenantId,
    secondClaim.lease,
    { expectedState: 'running', state: 'completed' },
  );
  assert(completed.state === 'completed', 'Session must enter completed');

  const failedClaim = await store.claimSession({
    tenantId: workerTenantId,
    ownerId: secondWorkerId,
    leaseId: ExecutionLeaseId(`failed-lease-${suffix}`),
    ttlMs: 10_000,
  });
  assert(
    failedClaim?.route.sessionId === failedSessionId,
    'Worker must claim the remaining queued Session',
  );
  if (!failedClaim) {
    throw new Error('unreachable');
  }
  const failed = await store.transitionSession(
    workerTenantId,
    failedClaim.lease,
    {
      expectedState: 'provisioning',
      state: 'failed',
      failure: { reason: 'conformance' },
    },
  );
  assert(failed.state === 'failed', 'Session must enter failed');

  const preemptedSessionId = SessionId(`preempted-${suffix}`);
  await store.enqueueSession(workerTenantId, preemptedSessionId);
  const preemptedClaim = await store.claimSession({
    tenantId: workerTenantId,
    ownerId: secondWorkerId,
    leaseId: ExecutionLeaseId(`preempted-a-${suffix}`),
    ttlMs: 10_000,
  });
  assert(preemptedClaim !== null, 'Worker must claim Session for preemption');
  await store.transitionSession(
    workerTenantId,
    preemptedClaim.lease,
    { expectedState: 'provisioning', state: 'running' },
  );
  const preempted = await store.preemptSession(
    workerTenantId,
    preemptedSessionId,
    { requeue: true, reason: { reason: 'higher_priority_work' } },
  );
  assert(preempted.state === 'queued', 'Preempted Session must be requeued');
  let preemptedFenceRejected = false;
  try {
    await store.transitionSession(
      workerTenantId,
      preemptedClaim.lease,
      { expectedState: 'queued', state: 'provisioning' },
    );
  } catch {
    preemptedFenceRejected = true;
  }
  assert(preemptedFenceRejected, 'Preemption must fence the previous worker');
  checks.push('worker-routing');

  const expiringWorkerId = WorkerId(`worker-expiring-${suffix}`);
  await store.registerWorker({
    workerId: expiringWorkerId,
    capacity: 1,
    ttlMs: 1_000,
  });
  const expiringSessionId = SessionId(`expiring-${suffix}`);
  await store.enqueueSession(workerTenantId, expiringSessionId, {
    priority: 100,
  });
  const expiringClaim = await store.claimSession({
    tenantId: workerTenantId,
    ownerId: expiringWorkerId,
    leaseId: ExecutionLeaseId(`expiring-lease-${suffix}`),
    ttlMs: 1_000,
  });
  assert(expiringClaim !== null, 'Expiring worker must initially claim work');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const recovery = await store.recoverExpiredWork();
  assert(recovery.offlineWorkers >= 1, 'Expired worker must become offline');
  assert(
    (await store.getSessionRoute(workerTenantId, expiringSessionId))?.state
      === 'suspended',
    'Expired Session lease must suspend the Session',
  );
  checks.push('worker-recovery');

  const effectTenantId = `effect-tenant-${suffix}`;
  const effectSessionId = SessionId(`effect-session-${suffix}`);
  const effectCommandId = CommandId(`effect-command-${suffix}`);
  await store.commitRuntimeTransaction({
    tenantId: effectTenantId,
    sessionId: effectSessionId,
    command: {
      commandId: effectCommandId,
      fingerprint: `fingerprint-${effectCommandId}`,
      result: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: effectCommandId,
        ok: true,
        data: {},
      },
    },
    effects: [
      {
        effectId: `effect-a-complete-${suffix}`,
        type: 'side-effect',
        payload: { order: 1 },
        idempotencyKey: `effect-key-a-${suffix}`,
        executionMode: 'idempotent',
      },
      {
        effectId: `effect-b-uncertain-${suffix}`,
        type: 'side-effect',
        payload: { order: 2 },
        idempotencyKey: `effect-key-b-${suffix}`,
        executionMode: 'at_most_once',
      },
      {
        effectId: `effect-c-requeue-${suffix}`,
        type: 'side-effect',
        payload: { order: 3 },
        idempotencyKey: `effect-key-c-${suffix}`,
        executionMode: 'at_most_once',
      },
    ],
  });
  await store.heartbeatWorker(secondWorkerId, 10_000);
  const [completedEffectClaim] = await store.claimEffects({
    tenantId: effectTenantId,
    workerId: secondWorkerId,
    ttlMs: 10_000,
    limit: 1,
  });
  assert(completedEffectClaim !== undefined, 'Pending effect must be claimable');
  const completedEffectLease = effectLease(completedEffectClaim);
  const renewedEffect = await store.renewEffectLease(
    completedEffectLease,
    10_000,
  );
  assert(
    renewedEffect.status === 'claimed'
    && renewedEffect.leaseExpiresAt !== undefined,
    'Claimed effect lease must be renewable',
  );
  await store.startEffect(completedEffectLease);
  const completedEffect = await store.completeEffect(
    completedEffectLease,
    { delivered: true },
  );
  assert(completedEffect.status === 'completed', 'Effect must complete');

  const [uncertainEffectClaim] = await store.claimEffects({
    tenantId: effectTenantId,
    workerId: secondWorkerId,
    ttlMs: 500,
    limit: 1,
  });
  assert(
    uncertainEffectClaim?.executionMode === 'at_most_once',
    'Second effect must use at-most-once delivery',
  );
  if (!uncertainEffectClaim) {
    throw new Error('unreachable');
  }
  const uncertainLease = effectLease(uncertainEffectClaim);
  await store.startEffect(uncertainLease);
  let invalidRetryRejected = false;
  try {
    await store.failEffect(
      uncertainLease,
      { reason: 'invalid-retry' },
      { retryAt: '' },
    );
  } catch (error) {
    invalidRetryRejected =
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'WORKER_INVALID';
  }
  assert(
    invalidRetryRejected,
    'Empty effect retryAt must fail with a stable validation error',
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  const uncertainRecovery = await store.recoverExpiredWork();
  assert(
    uncertainRecovery.uncertainEffects >= 1,
    'Expired started at-most-once effect must become uncertain',
  );

  const [unstartedEffectClaim] = await store.claimEffects({
    tenantId: effectTenantId,
    workerId: secondWorkerId,
    ttlMs: 500,
    limit: 1,
  });
  assert(
    unstartedEffectClaim !== undefined,
    'Remaining at-most-once effect must be claimable',
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  const unstartedRecovery = await store.recoverExpiredWork();
  assert(
    unstartedRecovery.requeuedEffects >= 1,
    'Claimed effect that never started must be requeued',
  );
  const [reclaimedEffect] = await store.claimEffects({
    tenantId: effectTenantId,
    workerId: secondWorkerId,
    ttlMs: 10_000,
    limit: 1,
  });
  assert(
    reclaimedEffect?.effectId === unstartedEffectClaim.effectId
    && reclaimedEffect.fencingToken > unstartedEffectClaim.fencingToken,
    'Reclaimed effect must use a higher fencing token',
  );
  if (!reclaimedEffect) {
    throw new Error('unreachable');
  }
  await store.startEffect(effectLease(reclaimedEffect));
  await store.completeEffect(effectLease(reclaimedEffect));
  const uncertainEffects = await store.listEffects(
    effectTenantId,
    { status: 'uncertain' },
  );
  assert(
    uncertainEffects.length === 1,
    'Uncertain at-most-once effect must not return to the pending queue',
  );
  const reconciledEffect = await store.reconcileEffect(
    effectTenantId,
    uncertainEffects[0]?.effectId ?? '',
    {
      status: 'failed',
      error: { reason: 'conformance_reconciled' },
    },
  );
  assert(
    reconciledEffect.status === 'failed',
    'Uncertain effect must support explicit reconciliation',
  );
  checks.push('effect-delivery');

  assert(
    Object.values(AgentCommandType).length > 0,
    'Protocol command catalog must be available',
  );
  return { checks };
}
