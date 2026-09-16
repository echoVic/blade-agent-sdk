# Runtime Store

`RuntimeStore` is the shared persistence boundary for server-hosted agents. It
stores command receipts, remote events, Session state, the durable journal,
Worker routes, and execution leases. `PostgresRuntimeStore` is the reference
implementation for multi-process deployments.

## Install and import

```bash
pnpm add @blade-ai/agent-sdk pg
```

```ts
import { AgentServer } from '@blade-ai/agent-sdk/server/infra';
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
- `SessionEventStore`, the atomic transcript projection update port.
- `DurableEventStore`, the Request, Turn, model, tool, and approval journal.
- `AgentServerStore`, the command receipt, remote event, and Session record store.

Once `runtimeStore` is configured, Session-level repository, event Store, or
durable Store overrides are rejected with `SESSION_CONFLICT`. This prevents
multiple persistence authorities from reintroducing dual writes.

## Command idempotency

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
await runtimeStore.completeCommand(
  tenantId,
  commandId,
  claim.leaseId,
  result,
);
```

`claimCommand()` checks the command ID and fingerprint and returns a saved
result for a completed command. `sealCommand()` makes the receipt non-expiring
before an external side effect may occur, and `completeCommand()` stores the
deterministic result. Recovery marks a command abandoned when it remains sealed
for too long; callers must reconcile it instead of replaying it automatically.

## PostgreSQL schema

`PostgresRuntimeStore.initialize()` idempotently creates ten tables:

| Table | Purpose |
|-------|---------|
| `*_metadata` | Runtime Store schema version |
| `*_commands` | Command fingerprint, lease, state, and deterministic result |
| `*_sessions` | Tenant-scoped Session records |
| `*_stream_heads` | Monotonic sequence per Session and stream |
| `*_events` | `agent` and `durable` events |
| `*_event_keys` | Idempotency keys independent of event retention |
| `*_session_states` | Complete Session state projections |
| `*_workers` | Worker heartbeat, drain state, and capacity |
| `*_execution_leases` | Session execution leases and fencing tokens |
| `*_session_routes` | Session scheduling state and current worker route |

`schema` and `tablePrefix` accept PostgreSQL identifiers only. Data values use
parameterized queries. Concurrent command and stream writes use
transaction-scoped advisory locks. PostgreSQL is authoritative; Redis is not in
the correctness path.

The current database schema version is `5`. `initialize()` creates that schema
under a global advisory lock and rejects metadata declaring any other version.
The adapter does not carry a legacy migration chain; deployments must migrate
or recreate an older database explicitly.

`InMemoryAgentServerStore` remains a test and single-process implementation. Do
not combine it with PostgreSQL transcript storage in production.

## Session projection

`SessionRepository` now describes only the read/projection API.
`SessionEventStore` describes transcript appends. One adapter may implement
both independent ports, but callers inject them separately and Session does not
infer capabilities from an object's method set.

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

Each PostgreSQL write updates `session_states` atomically under a row lock.
Reads, resume, and fork use that projection; there is no parallel transcript
event stream.

## Operational boundaries

- Schema initialization requires DDL privileges; production deployments may call `initialize()` during deployment.
- `close()` closes an internally created Pool; an injected Pool remains caller-owned.
- `maxAgentEventsPerSession` applies rolling retention to replayable SSE events.
- `maxDurableEventsPerSession` (default `100000`) is the hard write quota for
  the durable journal. The Store rejects an append at the limit instead of
  silently deleting recovery history.
- `maxSessionsPerTenant` applies only to transcript projection cleanup.
- See [Worker Runtime](./worker-runtime) for Worker heartbeat, Session routing,
  and recovery.
- Redis may provide notifications, wake-ups, and short-lived quotas only.
  Losing Redis data must not affect command, event, Session state, or lease
  correctness.
