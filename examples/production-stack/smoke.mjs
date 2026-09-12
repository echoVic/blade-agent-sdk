import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient } from '@blade-ai/agent-sdk/browser';

export async function runProductionSmoke({ baseUrl, store, state, tenantId, launchedAt,
  waitForCheckpoint, restartWorker, getWorker }) {
  const client = new AgentClient({ baseUrl: `${baseUrl}/v1/agent`,
    client: { name: 'blade-production-repository-smoke', version: '1.0.0' },
    headers: { authorization: 'Bearer local-demo' } });
  const cursors = new Map();
  const budget = AbortSignal.timeout(Math.max(1, Math.floor(300_000 - (performance.now() - launchedAt))));

  async function task(session, input, { approval = 'approve', crash = false, crashDuringApproval = false } = {}) {
    const submitted = await session.send(input, { signal: budget });
    let controller = new AbortController();
    let recovery;
    let reconnect = false;
    let approvals = 0;
    let writes = 0;
    let approvalRecoveryFence;
    let interruptedPermissionId;
    const decidedPermissionIds = new Set();
    const toolNames = [];
    if (crash) {
      recovery = (async () => {
        const checkpoint = await waitForCheckpoint(session.sessionId, budget);
        reconnect = true;
        controller.abort();
        const previousFence = (await store.getSessionRoute(tenantId, session.sessionId)).fencingToken;
        await restartWorker(checkpoint);
        return previousFence;
      })();
      // Attach immediately, while the stream consumes the approval and tool events.
      void recovery.catch(() => controller.abort());
    }
    try {
      for (;;) {
        try {
          for await (const event of session.events({
            after: cursors.get(session.sessionId), signal: AbortSignal.any([controller.signal, budget]),
          })) {
            cursors.set(session.sessionId, {
              protocolVersion: 1, sessionId: session.sessionId,
              sequence: event.sequence, eventId: event.eventId,
            });
            if (event.requestId && event.requestId !== submitted.requestId) continue;
            if (event.type === 'permission.requested') {
              assert.equal(event.data.toolName, 'RepoWrite');
              const permissionId = event.data.permissionRequestId;
              // Recovery republishes the existing permission. A duplicate
              // event must never produce a second authorization command.
              if (decidedPermissionIds.has(permissionId)) continue;
              approvals += 1;
              if (approval === 'cancel') {
                await session.abort({ signal: budget });
                assert.equal((await store.getSessionRoute(tenantId, session.sessionId)).state, 'idle');
                assert.equal((await state.getCancellation(session.sessionId, submitted.requestId)).status, 'completed');
                return { cancelled: true, approvals, writes };
              }
              if (crashDuringApproval && !interruptedPermissionId) {
                interruptedPermissionId = permissionId;
                const pending = await state.getPermission(session.sessionId, permissionId);
                assert.equal(pending.status, 'pending');
                assert.equal(pending.requestId, submitted.requestId);
                assert.deepEqual(pending.request.input, event.data.input);
                const previousRoute = await store.getSessionRoute(tenantId, session.sessionId);
                assert.equal(previousRoute.state, 'waiting_approval');
                const executionId = previousRoute.metadata.bladeRepository?.executionId;
                assert.ok(executionId, 'The waiting worker must own an isolated repository');
                approvalRecoveryFence = previousRoute.fencingToken;
                budget.throwIfAborted();
                await restartWorker({ sessionId: session.sessionId, executionId });
                // Do not approve against a dead owner's routing record. The
                // replacement must first take the fence and restore the wait.
                for (;;) {
                  budget.throwIfAborted();
                  const route = await store.getSessionRoute(tenantId, session.sessionId);
                  assert.notEqual(route.state, 'failed', JSON.stringify(route.failure));
                  if (route.fencingToken > approvalRecoveryFence && route.state === 'waiting_approval') break;
                  await delay(25, undefined, { signal: budget });
                }
              }
              if (crashDuringApproval) {
                const pending = await state.getPermission(session.sessionId, permissionId);
                assert.equal(pending.status, 'pending', 'A new operation must not inherit the earlier approval');
                assert.equal(pending.requestId, submitted.requestId);
                assert.deepEqual(pending.request.input, event.data.input);
              }
              await client.resolvePermission(session.sessionId, permissionId,
                { approved: approval === 'approve', scope: 'once' }, { signal: budget });
              decidedPermissionIds.add(permissionId);
              if (crashDuringApproval) {
                const decided = await state.getPermission(session.sessionId, permissionId);
                assert.equal(decided.status, 'resolved', 'API approval must be persisted before acknowledging');
                assert.deepEqual(decided.decision, { approved: true, scope: 'once' });
              }
            }
            if (event.type !== 'session.stream') continue;
            assert.equal(event.requestId, submitted.requestId, `Missing request correlation for ${event.data.type}`);
            if (event.data.type === 'tool_use') toolNames.push(event.data.name);
            if (event.data.type === 'tool_result' && event.data.name === 'RepoWrite' && !event.data.isError) writes += 1;
            if (event.data.type === 'result') {
              assert.equal(event.data.subtype, 'success', JSON.stringify(event.data));
              assert.equal((await store.getSessionRoute(tenantId, session.sessionId)).state, 'idle');
              const previousFence = recovery ? await recovery : approvalRecoveryFence ?? null;
              const route = await store.getSessionRoute(tenantId, session.sessionId);
              if (previousFence !== null) assert.ok(route.fencingToken > previousFence);
              if (interruptedPermissionId) {
                const durable = await store.forTenant(tenantId).read(session.sessionId);
                assert.ok(durable.events.some((item) => item.type === 'permission_resolved'
                  && item.data.permissionRequestId === interruptedPermissionId && item.data.decision === 'allow'),
                'The successor must apply the persisted decision for the original pending permission');
                assert.equal(writes, 1, 'Approval recovery must apply the repository change once');
              }
              return { output: event.data.content, approvals, writes, toolNames,
                ...(interruptedPermissionId ? { interruptedPermissionId, decidedPermissionIds: [...decidedPermissionIds] } : {}),
                ...(previousFence !== null ? { recovered: true, previousFence, fencingToken: route.fencingToken } : {}) };
            }
          }
          throw new Error('Event stream ended before the task result');
        } catch (error) {
          if (!reconnect || budget.aborted) throw error;
          await recovery;
          await client.resumeSession(session.sessionId, { signal: budget });
          reconnect = false;
          controller = new AbortController();
        }
      }
    } finally { controller.abort(); }
  }

  const session = await client.createSession({ source: 'production-stack-smoke', smokeCrashAfterWrite: true }, { signal: budget });
  const first = await task(session, 'Fix the greeting to say Hello, Blade! and run the tests.', { crash: true });
  assert.match(first.output, /Hello, Blade!/);
  assert.match(first.output, /pass/i);
  assert.equal(first.approvals, 1, 'Recovery must not ask to repeat a completed file replacement');
  const firstResultMs = Math.round((performance.now() - launchedAt) * 100) / 100;
  const second = await task(session, 'Read the saved greeting and run the tests again.');
  assert.equal(second.approvals, 0, 'The second turn must restore the modified workspace');
  assert.match(second.output, /pass/i);
  const snapshot = await client.readSession(session.sessionId, { signal: budget });
  assert.ok(snapshot.messages.some((message) => message.role === 'tool'), 'Real tool history must be persisted');

  const approvalSession = await client.createSession({ source: 'production-approval-recovery-smoke' }, { signal: budget });
  const approvalRecovery = await task(approvalSession, 'Fix the greeting and run tests.', { crashDuringApproval: true });
  assert.match(approvalRecovery.output, /pass/i);
  assert.ok(approvalRecovery.recovered);

  const deniedSession = await client.createSession({ source: 'production-denial-smoke' }, { signal: budget });
  const denied = await task(deniedSession, 'Fix the greeting and run tests.', { approval: 'deny' });
  assert.equal(denied.approvals, 1);
  assert.equal(denied.writes, 0);
  const deniedState = await state.get(deniedSession.sessionId);
  assert.ok(!deniedState.checkpointId, 'Denied writes must not checkpoint a modified workspace');

  const cancelledSession = await client.createSession({ source: 'production-cancel-smoke' }, { signal: budget });
  const cancelled = await task(cancelledSession, 'Fix the greeting and run tests.', { approval: 'cancel' });
  const afterCancel = await task(cancelledSession, 'Fix the greeting and run tests.');
  assert.match(afterCancel.output, /pass/i);

  const [readyResponse, metricsResponse] = await Promise.all([
    fetch(`${baseUrl}/v1/runtime/readyz`, { signal: budget }),
    fetch(`${baseUrl}/v1/runtime/metrics`, { signal: budget, headers: { authorization: 'Bearer local-demo' } }),
  ]);
  assert.ok(readyResponse.ok && metricsResponse.ok);
  const health = await readyResponse.json();
  const metrics = await metricsResponse.json();
  await Promise.all([session.close({ signal: budget }), approvalSession.close({ signal: budget }), deniedSession.close({ signal: budget }), cancelledSession.close({ signal: budget })]);
  return { sessionId: session.sessionId, firstResultMs, output: first.output,
    recovery: first, secondTurn: second, approvalRecovery, denied, cancelled, afterCancel,
    operations: { health, queue: metrics.queue }, worker: getWorker() };
}
