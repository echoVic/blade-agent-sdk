# Worker Runtime

Worker Runtime adds Worker liveness, Session routing, and execution-lease
recovery on the shared `RuntimeStore`. PostgreSQL remains the only coordination
source of truth. Redis may provide notifications, wake-ups, and short-lived
quotas only.

## AgentWorker

`AgentWorker` combines Worker registration, heartbeat, Session claims, lease
renewal, and recovery scans into one long-running execution loop. A
`SessionRunner` executes one already-fenced Session:

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
  returns `sessionRepository`, `sessionEventStore`, `durableEventStore`,
  `durableExecutionLeaseStore`, or `executionLease`, the runner throws a
  `TypeError`. On completion it merges `durableHandoff` into route metadata.

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

A `draining` Worker cannot claim new Sessions. It may keep heartbeating while
it finishes owned work. If a drain races a claim, the Worker can hold a Session
whose status is no longer `running`; it then hands that
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

## Session execution fence

`runtimeStore.forTenant(tenantId)` implements
`DurableExecutionLeaseStore`. After claiming a Session, pass the claim owner
and lease ID to the Session:

```ts
const session = await resumeSession({
  ...sessionOptions,
  sessionId: claim.route.sessionId,
  durableExecutionLeaseStore: runtimeStore.forTenant(claim.route.tenantId),
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

### Custom SessionRunner

The `SessionRunner` contract is owned by `/advanced`. Custom implementations
should implement the interface directly and must not depend on `AgentWorker`
private state or import types from the deprecated `/server` entrypoint:

```ts
import type {
  SessionRunner,
  SessionRunnerContext,
  SessionRunResult,
} from '@blade-ai/agent-sdk/advanced';

export class RepositorySessionRunner implements SessionRunner {
  // When omitted, AgentWorker renews the claim lease.
  readonly managesLease = false;

  async run(context: SessionRunnerContext): Promise<SessionRunResult> {
    const { route } = context.claim;
    await context.transition('running', {
      ...route.metadata,
      executor: 'repository',
    });

    try {
      const result = await runRepositoryAgent({
        sessionId: route.sessionId,
        store: context.store.forTenant(route.tenantId),
        signal: context.signal,
        executionHost: context.executionHost,
      });

      // Release files, processes, and sockets before returning.
      await result.dispose();

      return {
        status: result.completed ? 'completed' : 'idle',
        metadata: {
          ...route.metadata,
          checkpointId: result.checkpointId,
        },
        // Publish terminal output only after the fenced route settlement.
        finalize: () => publishTerminalResult(route, result),
      };
    } catch (error) {
      if (context.signal.aborted) {
        await suspendRepositoryAgent(route.sessionId);
        return { status: 'suspended', metadata: route.metadata };
      }
      return {
        status: 'failed',
        failure: {
          message: error instanceof Error ? error.message : String(error),
        },
        metadata: route.metadata,
      };
    }
  }
}
```

Every implementation must preserve these boundaries:

- `run()` handles only the tenant, Session, and fencing token in
  `context.claim`.
- `transition()` is only for `running` and `waiting_approval`; the Worker owns
  terminal settlement.
- Return `failed` when recovery safety cannot be proven; never guess `idle`.
- Stop admitting side effects after `context.signal` aborts and finish
  deterministic cleanup before returning.
- Use `finalize` only to publish settled outcomes, never for required cleanup,
  checkpoints, or persistence.
- Set `managesLease = true` only when the runner owns renewal and fencing
  validation.

`SdkSessionRunner` is the default implementation for SDK Sessions. Instantiate
it directly when all of its semantics are needed. Domain executors should
implement `SessionRunner` instead of subclassing and overriding its internal
flow.

## Recovery loop

Schedulers should periodically run:

```ts
const recovered = await store.recoverExpiredWork();
```

The operation:

1. Marks workers with expired heartbeats as `offline`.
2. Releases their execution leases and suspends active Sessions.
3. Marks commands that remain sealed past the safety window as `abandoned`, so
   callers reconcile them instead of replaying them automatically.

## Health and telemetry

`worker.getHealth()` is a local, I/O-free snapshot. Readiness requires a
`running` worker and a successful heartbeat newer than the worker TTL.
`draining` and `stopped` workers remain live but are not ready.

`AgentWorkerTelemetry` is an explicit injection port with `recordSnapshot()`
and `recordError()`. The SDK does not bind a telemetry backend. Implementations
must not throw into the Worker lifecycle or retain Session input or credentials.

## Failure boundaries

- Session leases use monotonic fencing tokens.
- Drain never forcibly stops work; handoff remains explicit.
- Worker heartbeat and Session leases use independent TTLs and must both renew.
- A timed-out sealed command is abandoned and never executed automatically.
- PostgreSQL transactions and advisory locks enforce correctness; Redis loss
  cannot change outcomes.
