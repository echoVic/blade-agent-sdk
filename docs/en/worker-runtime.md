# Worker Runtime

Worker Runtime adds worker liveness, Session routing, execution leases, and
effect outbox recovery on the shared `RuntimeStore`. PostgreSQL remains the
only coordination source of truth. Redis may provide notifications, wake-ups,
and short-lived quotas only.

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
  metadata: { zone: 'us-east-1' },
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
heartbeating while it finishes owned work. After `suspendForHandoff()`
completes, persist the handoff:

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
| `running` | Session execution is active | `waiting_approval`, `suspended`, `completed`, `failed` |
| `waiting_approval` | Waiting for external approval while retaining the lease | `running`, `suspended`, `failed` |
| `suspended` | Unowned and available for recovery | `queued`, `provisioning`, `completed`, `failed` |
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

## Effect outbox

Effects support two execution modes:

- `idempotent`: the target accepts an idempotency key, so an interrupted
  execution may be claimed again.
- `at_most_once`: for operations that cannot be replayed safely. Once the
  effect enters `executing`, it is never retried automatically.

```ts
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

const [effect] = await store.claimEffects({
  tenantId,
  workerId,
  ttlMs: 30_000,
  limit: 1,
});

if (effect) {
  const lease = effectLease(effect);
  await store.startEffect(lease);
  await executeExternalEffect(effect.payload);
  await store.completeEffect(lease, { delivered: true });
}
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

## Failure boundaries

- Session and effect leases use monotonic fencing tokens.
- Drain never forcibly stops work; handoff remains explicit.
- Preemption immediately invalidates the previous fence.
- Worker heartbeat and task leases use independent TTLs and must both renew.
- `uncertain` is a reconciliation terminal state and is never normally claimed.
- PostgreSQL transactions and advisory locks enforce correctness; Redis loss
  cannot change outcomes.
