# Runtime Store

`RuntimeStore` is the shared persistence boundary for server-hosted agents. It
commits command receipts, domain events, effect intents, and projection
checkpoints in one transaction while exposing adapters for `AgentServer`,
Session transcripts, and the durable execution journal.

## Install and import

```bash
pnpm add @blade-ai/agent-sdk pg
```

```ts
import { AgentServer } from '@blade-ai/agent-sdk/server';
import { PostgresRuntimeStore } from '@blade-ai/agent-sdk/server/postgres';

const runtimeStore = new PostgresRuntimeStore({
  connectionString: process.env.DATABASE_URL!,
});

const server = new AgentServer({
  runtimeStore,
  authenticate,
  resolveSessionOptions: () => ({
    provider,
    model,
  }),
  requirePersistentSessions: true,
});
```

When `runtimeStore` is present, the default `InProcessSessionExecutor` scopes
it with the authenticated `tenantId` and uses that same Store as:

- `SessionRepository`, the read-only transcript projection.
- `SessionEventStore`, the transcript event append port.
- `DurableEventStore`, the Request, Turn, model, tool, and approval journal.
- `AgentServerStore`, the command receipt, remote event, and Session record store.

Once `runtimeStore` is configured, Session-level repository, event Store, or
durable Store overrides are rejected with `SESSION_CONFLICT`. This prevents
multiple persistence authorities from reintroducing dual writes.

## Transaction model

```ts
const claim = await runtimeStore.claimCommand(
  tenantId,
  commandId,
  commandFingerprint,
  30_000,
);

if (claim.status !== 'claimed') {
  throw new Error(`Unexpected claim: ${claim.status}`);
}

await runtimeStore.sealCommand(tenantId, commandId, claim.leaseId);

await runtimeStore.commitRuntimeTransaction({
  tenantId,
  sessionId,
  command: {
    commandId,
    fingerprint: commandFingerprint,
    leaseId: claim.leaseId,
    result: {
      protocolVersion: 1,
      commandId,
      ok: true,
      data: { accepted: true },
    },
  },
  expectedLastSequence: null,
  events: [{
    type: 'request.accepted',
    data: { requestId: 'request-1' },
  }],
  effects: [{
    effectId: 'effect-1',
    type: 'tool.execute',
    payload: { toolName: 'Search' },
    idempotencyKey: 'request-1:tool-1',
  }],
  projection: {
    name: 'request',
    expectedOffset: null,
    offset: 1,
    state: { status: 'accepted' },
  },
});
```

One PostgreSQL transaction:

1. Validates the command fingerprint and optional lease.
2. Compare-and-appends domain events.
3. Inserts effect intents with unique idempotency keys.
4. CAS-updates projection state and offset.
5. Marks the command receipt completed with its deterministic result.

Any failure rolls back every write. Retrying a completed command returns
`status: 'replayed'` without duplicating events or effects. Reusing a command ID
for a different payload throws `RUNTIME_STORE_COMMAND_CONFLICT`.

## PostgreSQL schema

`PostgresRuntimeStore.initialize()` idempotently creates ten tables:

| Table | Purpose |
|-------|---------|
| `*_metadata` | Runtime Store schema version |
| `*_commands` | Command fingerprint, lease, state, and deterministic result |
| `*_sessions` | Tenant-scoped Session records |
| `*_stream_heads` | Monotonic sequence per Session and stream |
| `*_events` | `agent`, `domain`, `durable`, and `transcript` events |
| `*_outbox` | Effect intents waiting for execution |
| `*_projections` | Projection state and consumed offset |
| `*_workers` | Worker heartbeat, drain state, and capacity |
| `*_execution_leases` | Session execution leases and fencing tokens |
| `*_session_routes` | Session scheduling state and current worker route |

`schema` and `tablePrefix` accept PostgreSQL identifiers only. Data values use
parameterized queries. Concurrent command and stream writes use
transaction-scoped advisory locks. PostgreSQL is authoritative; Redis is not in
the correctness path.

The current database schema version is `3`. `initialize()` migrates a v1
outbox to the worker/effect lease schema and upgrades the v2 Session route
constraint to support `idle`, all under a global advisory lock. The
domain-event schema remains at version `1`, so existing events do not require
rewriting.

`InMemoryAgentServerStore` remains a test and single-process implementation. Do
not combine it with PostgreSQL transcript storage in production.

## Session projection

`SessionRepository` now describes only the read/projection API.
`SessionEventStore` describes transcript appends, while `SessionPersistence`
combines both for compatibility. The existing `JsonlSessionRepository`
continues to implement the combined interface, so local Node.js usage is
unchanged.

```ts
interface SessionRepository extends SessionStore {
  initialize(): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
  cleanupOldSessions(): Promise<void>;
  getStorageStats(): Promise<SessionRepositoryStorageStats>;
  checkStorageHealth(): Promise<SessionRepositoryHealth>;
}

interface SessionEventStore {
  createSession(...): Promise<void>;
  saveMessage(...): Promise<string>;
  saveToolUse(...): Promise<PersistedToolUse>;
  saveToolResult(...): Promise<string>;
  // Input, compaction, and context append methods.
}
```

Each PostgreSQL transcript append writes a `transcript` event and updates the
`session` projection in the same transaction. Reads, resume, and fork use only
that projection.

## Queue metrics capability

The PostgreSQL adapter implements the optional
`getQueueMetrics(tenantId?)` capability:

```ts
const metrics = await runtimeStore.getQueueMetrics?.(tenantId);
```

The result contains zero-filled counts for every Session and effect state,
current claimable counts, oldest-backlog timestamps and ages, plus global
active/draining/offline Worker counts, total capacity, active Sessions, and
available capacity. Session and effect values are tenant-scoped; Worker
capacity describes the shared scheduler.

The method remains optional on `WorkerRuntimeStore`, preserving compatibility
for existing third-party Store implementations throughout `6.0.x`.
`AgentRuntimeOperations` returns HTTP `501` when a Store does not expose the
capability.

## Conformance

Third-party Stores can run the public framework-independent conformance suite:

```ts
import {
  assertRuntimeStoreConformance,
} from '@blade-ai/agent-sdk/server/testing';

await assertRuntimeStoreConformance(runtimeStore, {
  tenantId: 'conformance-a',
  otherTenantId: 'conformance-b',
});
```

The suite verifies health, Session projection, tenant isolation, command
receipts, agent and durable events, atomic commits, transaction rollback,
projection checkpoints, worker routing, lease recovery, and effect delivery.
When the Store exposes queue metrics, the suite also verifies tenant scoping
and capacity accounting. Run it against a dedicated schema or test database.

## Operational boundaries

- Schema initialization requires DDL privileges; production deployments may call `initialize()` during deployment.
- `close()` closes an internally created Pool; an injected Pool remains caller-owned.
- `maxAgentEventsPerSession` applies rolling retention to replayable SSE events.
- `maxDurableEventsPerSession`, `maxDomainEventsPerSession`, and
  `maxTranscriptEventsPerSession` (each `100000` by default) are hard write
  quotas for non-truncatable streams. The Store rejects an append at the limit
  instead of silently deleting recovery or audit history.
- `maxSessionsPerTenant` applies only to transcript projection cleanup.
- See [Worker Runtime](./worker-runtime) for outbox claims, worker heartbeat,
  Session routing, and recovery.
- Redis may provide notifications, wake-ups, and short-lived quotas only. Losing Redis data must not affect command, event, effect, or projection correctness.
