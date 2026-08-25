# Runtime Store

`RuntimeStore` is the shared persistence boundary for server-hosted agents. It
commits command receipts, domain events, effect intents, and projection
checkpoints in one transaction while exposing adapters for `AgentServer`,
Session transcripts, and the durable execution journal.

## Install and import

```bash
pnpm add @blade-ai/agent-sdk
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

`PostgresRuntimeStore.initialize()` idempotently creates seven tables:

| Table | Purpose |
|-------|---------|
| `*_metadata` | Runtime Store schema version |
| `*_commands` | Command fingerprint, lease, state, and deterministic result |
| `*_sessions` | Tenant-scoped Session records |
| `*_stream_heads` | Monotonic sequence per Session and stream |
| `*_events` | `agent`, `domain`, `durable`, and `transcript` events |
| `*_outbox` | Effect intents waiting for execution |
| `*_projections` | Projection state and consumed offset |

`schema` and `tablePrefix` accept PostgreSQL identifiers only. Data values use
parameterized queries. Concurrent command and stream writes use
transaction-scoped advisory locks. PostgreSQL is authoritative; Redis is not in
the correctness path.

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
receipts, agent and durable events, atomic commits, transaction rollback, and
projection checkpoints. Run it against a dedicated schema or test database.

## Operational boundaries

- Schema initialization requires DDL privileges; production deployments may call `initialize()` during deployment.
- `close()` closes an internally created Pool; an injected Pool remains caller-owned.
- `maxAgentEventsPerSession` limits replayable SSE events, not durable or domain events.
- `maxSessionsPerTenant` applies only to transcript projection cleanup.
- This release writes and queries the outbox. Effect claim, heartbeat, and recovery belong to the next Worker lease milestone.
- Redis may provide notifications, wake-ups, and short-lived quotas only. Losing Redis data must not affect command, event, effect, or projection correctness.
