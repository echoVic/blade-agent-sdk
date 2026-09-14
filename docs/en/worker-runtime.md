# Worker Runtime

Worker Runtime adds worker liveness, Session routing, execution leases, and
effect outbox recovery on the shared `RuntimeStore`. PostgreSQL remains the
only coordination source of truth. Redis may provide notifications, wake-ups,
and short-lived quotas only.

## AgentWorker

`AgentWorker` combines worker registration, heartbeat, Session claims, lease
renewal, recovery scans, and optional effect consumption into one long-running
execution loop. A `SessionRunner` executes one already-fenced Session:

```ts
import {
  AgentWorker,
} from '@blade-ai/agent-sdk/server/infra';
import { SdkSessionRunner } from '@blade-ai/agent-sdk/advanced';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';
import { WorkerId } from '@blade-ai/agent-sdk';

const store = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});
const worker = new AgentWorker({
  store,
  workerId: WorkerId(crypto.randomUUID()),
  capacity: 8,
  sessionRunner: new SdkSessionRunner({
    resolveSessionOptions: () => ({
      provider,
      model,
      allowedTools: [],
    }),
  }),
  effectHandlers: [{
    type: 'payment.capture',
    execute: ({ effect, signal }) =>
      paymentProvider.capture(effect.payload, effect.idempotencyKey, signal),
  }],
});

const shutdownController = new AbortController();
process.once('SIGTERM', () => shutdownController.abort());
await worker.run(shutdownController.signal);
```

`SdkSessionRunner` resumes an already-persisted Request and injects the current
tenant Store and worker lease. After a turn settles, the route enters `idle`
and releases its lease so later input can enqueue it again.

Four contracts matter when you use it:

- **Publish stream events.** Events from `session.stream()` do not reach the
  control plane on their own, so pass a `publish` callback. Without it the
  browser receives no streamed output or result:

  ```ts
  sessionRunner: new SdkSessionRunner({
    resolveSessionOptions: () => ({ provider, model, allowedTools: [] }),
    publish: async (tenantId, sessionId, type, data, requestId) => {
      await store.appendEvent(tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        requestId,
        occurredAt: new Date().toISOString(),
        type,
        data,
      });
    },
  }),
  ```

- **Request correlation.** Every published event is bound to the request that
  produced it. When an event carries no request id of its own, the runner reuses
  the active request id of the turn, so one request's output cannot leak into a
  neighbouring request.
- **Losing the route suspends the run.** When the worker is drained or
  cancelled, the runner returns `{ status: 'suspended' }` and the Worker hands
  the Session off instead of reporting a stale result as a normal completion.
- **It owns persistence and the execution lease.** If `resolveSessionOptions`
  returns `sessionRepository`, `sessionEventStore`, `durableEventStore`, or
  `executionLease`, the runner throws a `TypeError`. On completion it merges
  `durableHandoff` into route metadata.

Use `ExecutionHostSessionRunner` when the workload needs an isolated workspace.
It persists checkpoint references in route metadata so a successor worker can
restore through the same `ExecutionHost` backend. See the runnable
[`examples/postgres-worker-recovery`](https://github.com/echoVic/blade-agent-sdk/tree/main/examples/postgres-worker-recovery)
example.

### Defaults and constraints

`AgentWorker` uses these defaults when an option is omitted:

| Option | Default | Notes |
|--------|---------|-------|
| `workerTtlMs` | `15_000` | Worker registration lease |
| `sessionLeaseTtlMs` | `30_000` | Lease for one Session claim |
| `heartbeatIntervalMs` | `5_000` | Must be lower than both TTLs or the constructor throws a `TypeError` |
| `pollIntervalMs` | `250` | Poll interval for an empty queue |
| `recoveryIntervalMs` | `5_000` | Recovery scan interval for expired leases |

`EffectDispatcher` defaults to `retryDelayMs` `1_000`, `maxRetryDelayMs`
`30_000`, `maxAttempts` `3`, `leaseTtlMs` `30_000`, and `claimLimit` `10`; a
`claimLimit` above 100 is rejected.

## Worker lifecycle

```ts
import {
  ExecutionLeaseId,
  SessionId,
  WorkerId,
} from '@blade-ai/agent-sdk';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';

const store = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});

const workerId = WorkerId(crypto.randomUUID());
await store.registerWorker({
  workerId,
  capacity: 8,
  ttlMs: 30_000,
  metadata: { zone: 'cn-north-1' },
});

await store.heartbeatWorker(workerId, 30_000);
```

A worker must continue heartbeating within its TTL. `recoverExpiredWork()`
marks expired workers `offline` and moves their active Sessions to
`suspended`.

Drain a worker before a rolling deployment:

```ts
await store.drainWorker(workerId);
```

A `draining` worker cannot claim new Sessions or effects. It may keep
heartbeating while it finishes owned work. If a drain races a claim, the worker
can hold a Session whose status is no longer `running`; it then hands that
Session off immediately and records
`handoffReason: 'worker_draining_before_start'` in the route metadata. After
`suspendForHandoff()` completes, persist the handoff:

```ts
await store.handoffSession(tenantId, lease, {
  reason: 'rolling_deploy',
});
```

## Session routing and states

```ts
const sessionId = SessionId(crypto.randomUUID());
await store.enqueueSession(tenantId, sessionId, {
  priority: 10,
});

const claim = await store.claimSession({
  tenantId,
  ownerId: workerId,
  leaseId: ExecutionLeaseId(crypto.randomUUID()),
  ttlMs: 30_000,
});

if (claim) {
  await store.transitionSession(tenantId, claim.lease, {
    expectedState: 'provisioning',
    state: 'running',
  });
}
```

Public states:

| State | Meaning | Allowed next states |
|-------|---------|---------------------|
| `queued` | Waiting for a worker | `provisioning`, `failed` |
| `provisioning` | Claimed while the execution environment is prepared | `running`, `suspended`, `failed` |
| `running` | Session execution is active | `waiting_approval`, `suspended`, `idle`, `completed`, `failed` |
| `waiting_approval` | Waiting for external approval while retaining the lease | `running`, `suspended`, `failed` |
| `suspended` | Unowned and available for recovery | `queued`, `provisioning`, `idle`, `completed`, `failed` |
| `idle` | The turn settled without an owner and may be queued again | `queued`, `completed`, `failed` |
| `completed` | Successful terminal state | None |
| `failed` | Failed terminal state | None |

Every new claim increments `fencingToken`. State transitions require the
current `leaseId + fencingToken`, so an old worker cannot commit state or
durable events after another worker takes ownership.

`preemptSession()` immediately releases the active lease and moves the Session
to `suspended` or back to `queued`. It is a control-plane operation; callers
must also cancel the old worker's compute resources.

## Session execution fence

`runtimeStore.forTenant(tenantId)` implements
`DurableExecutionLeaseStore`. After claiming a Session, pass the claim owner
and lease ID to the Session:

```ts
const session = await resumeSession({
  ...sessionOptions,
  sessionId: claim.route.sessionId,
  executionLease: {
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    ttlMs: 30_000,
  },
});
```

Once a Session has created an execution lease, the requirement is sticky.
Durable appends without a fence, with an expired fence, or with a fence replaced
by another worker fail closed.

### Runner results and finalization

`SessionRunner.run()` returns a `SessionRunResult`, which is exported from
`/advanced` together with `SessionRunner` and `SessionRunnerContext`:

```ts
type SessionRunResult =
  | { status: 'idle' | 'completed' | 'suspended'; metadata?: JsonObject; finalize?: () => Promise<void> }
  | { status: 'failed'; failure: JsonObject; metadata?: JsonObject; finalize?: () => Promise<void> };
```

The Worker settles the route to `idle`, `completed`, or `failed`, or hands the
Session off when the result is `suspended`. `finalize` runs only after that
fenced settlement or handoff succeeds, so it is the place to publish a confirmed
outcome. It is skipped when the transition fails, and the Worker instead treats
the lease as unrecovered so recovery can run.

Because `finalize` is conditional, runners must finish their own resource
cleanup before `run()` resolves. Do not rely on `finalize` to release handles
that must be released.

## Effect outbox

Effects support two execution modes:

- `idempotent`: the target accepts an idempotency key, so an interrupted
  execution may be claimed again.
- `at_most_once`: for operations that cannot be replayed safely. Once the
  effect enters `executing`, it is never retried automatically.

```ts
import { EffectDispatcher } from '@blade-ai/agent-sdk/advanced';

await store.commitRuntimeTransaction({
  tenantId,
  sessionId,
  command,
  effects: [{
    effectId: crypto.randomUUID(),
    type: 'payment.capture',
    payload: { paymentId },
    idempotencyKey: `payment:${paymentId}`,
    executionMode: 'at_most_once',
  }],
});

const dispatcher = new EffectDispatcher({
  store,
  workerId,
  handlers: [{
    type: 'payment.capture',
    async execute({ effect, signal }) {
      return paymentProvider.capture(
        effect.payload,
        effect.idempotencyKey,
        signal,
      );
    },
  }],
});

await dispatcher.run(shutdownSignal);
```

Workers must preserve the
`claim -> startEffect -> external side effect -> completeEffect` order:

- A crash before `startEffect` returns the effect to `pending` after lease
  expiry.
- A crash after `startEffect` moves an `at_most_once` effect to `uncertain`
  instead of replaying it.
- An interrupted `idempotent` effect returns to `pending`; the target system
  deduplicates with the idempotency key.

At-most-once delivery prevents duplicates but does not guarantee execution.
An `uncertain` effect must not be retried directly. After business
reconciliation, use `reconcileEffect()` to resolve it explicitly to
`completed` or `failed`.
When an `at_most_once` handler has sent a request but cannot prove its outcome,
throwing `UncertainRuntimeEffectError` marks the effect `uncertain`. Throwing it
from an `idempotent` handler is not treated as retryable: the effect is recorded
as a terminal `failed`, so express retryable idempotent failures with
`RetryableRuntimeEffectError` instead.

Long-running work must renew both worker heartbeat and the effect lease:

```ts
await store.heartbeatWorker(workerId, 30_000);
await store.renewEffectLease(effectLease(effect), 30_000);
```

## Recovery loop

Schedulers should periodically run:

```ts
const recovered = await store.recoverExpiredWork();
```

The operation:

1. Marks workers with expired heartbeats as `offline`.
2. Releases their execution leases and suspends active Sessions.
3. Returns claimed but unstarted effects to `pending`.
4. Requeues executing `idempotent` effects only.
5. Marks executing `at_most_once` effects `uncertain`.

## Production operations

`AgentRuntimeOperations` exposes an operations surface separate from the Agent
protocol. Every endpoint except liveness and readiness requires caller-supplied
authorization and is scoped to the tenant returned by that callback:

```ts
import {
  AgentRuntimeOperations,
} from '@blade-ai/agent-sdk/server/infra';

const operations = new AgentRuntimeOperations({
  store,
  workers: () => [worker],
  authorize: async (request, action) => {
    const operator = await authenticateOperator(request, action);
    return operator
      ? { tenantId: operator.tenantId, subject: operator.id }
      : null;
  },
});

const response = await operations.handle(request);
```

Default routes:

| Route | Purpose |
|-------|---------|
| `GET /v1/runtime/healthz` | Process and Worker liveness |
| `GET /v1/runtime/readyz` | Store and configured-Worker readiness |
| `GET /v1/runtime/metrics` | Tenant Session/effect backlog and global Worker capacity |
| `GET /v1/runtime/effects/uncertain` | Redacted uncertain-effect list |
| `POST /v1/runtime/effects/:id/reconcile` | Resolve an effect to `completed` or `failed` |

A reconciliation body is either:

```json
{ "status": "completed", "result": { "receiptId": "provider-123" } }
```

or:

```json
{ "status": "failed", "error": { "reason": "provider_rejected" } }
```

The HTTP list omits effect payloads and idempotency keys. The underlying
`reconcileEffect()` operation still accepts only `uncertain` effects.
Unauthenticated health/readiness responses expose aggregate counts only, not
Worker IDs, Session IDs, Store details, or failure payloads. When no local
Workers are configured, readiness depends on the Store alone.

`worker.getHealth()` is a local, I/O-free snapshot. Readiness requires a
`running` worker and a successful heartbeat newer than the worker TTL.
`draining` and `stopped` workers remain live but are not ready.

## Worker OpenTelemetry

```ts
import {
  OpenTelemetryAgentWorkerTelemetry,
} from '@blade-ai/agent-sdk/server/otel';

const worker = new AgentWorker({
  // ...
  telemetry: new OpenTelemetryAgentWorkerTelemetry(),
});
```

The adapter exports readiness, active Session, claim, success/failure,
recovery-duration, and uncertain-effect instruments. It omits prompts, effect
payloads, Session IDs, credentials, and Worker IDs by default. Set
`includeWorkerIdAttribute: true` to opt into Worker ID attributes.

## Failure boundaries

- Session and effect leases use monotonic fencing tokens.
- Drain never forcibly stops work; handoff remains explicit.
- Preemption immediately invalidates the previous fence.
- Worker heartbeat and task leases use independent TTLs and must both renew.
- `uncertain` is a reconciliation terminal state and is never normally claimed.
- PostgreSQL transactions and advisory locks enforce correctness; Redis loss
  cannot change outcomes.
