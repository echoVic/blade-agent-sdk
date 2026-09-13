# Server Runtime

`AgentServer` exposes server-profile Sessions through a versioned command API
and a replayable SSE event stream. Browsers use `AgentClient`; they never load
model providers, tool executors, or local host capabilities.

## Runtime boundaries

| Entry | Responsibility |
|-------|----------------|
| `@blade-ai/agent-sdk/server` | `AgentServer`, control-plane Store, tenant admission, and telemetry |
| `@blade-ai/agent-sdk/browser` | `AgentClient`, `RemoteAgentSession`, and protocol types |
| `@blade-ai/agent-sdk/protocol` | Browser-safe command/event schemas, parsers, and errors |
| `@blade-ai/agent-sdk/node` | Local JSONL repository and Node adapters such as files, shell, and sandbox |

`/server` never interprets `storagePath` as permission to access local files.
A resumable Session requires an explicitly supplied `sessionRepository` and
`sessionEventStore`, or one `runtimeStore`. Set
`requirePersistentSessions: true` to fail closed on incomplete configuration.

## Create a server

The OpenTelemetry adapter is an opt-in peer. Install
`@opentelemetry/api` and import the adapter from `/server/otel`.

```ts
import {
  AgentServer,
  type AgentPrincipal,
} from '@blade-ai/agent-sdk/server';
import {
  OpenTelemetryAgentServerTelemetry,
} from '@blade-ai/agent-sdk/server/otel';
import { JsonlSessionRepository } from '@blade-ai/agent-sdk/node';

const repository = new JsonlSessionRepository('/var/lib/my-agent');

const server = new AgentServer({
  authenticate(request): AgentPrincipal | null {
    const token = request.headers.get('authorization');
    if (token !== `Bearer ${process.env.AGENT_API_TOKEN}`) {
      return null;
    }
    return {
      tenantId: 'tenant-from-auth',
      subject: 'user-from-auth',
      scopes: [
        'session:create',
        'session:read',
        'session:write',
        'permission:resolve',
      ],
    };
  },
  resolveSessionOptions({ principal }) {
    return {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
      },
      model: 'gpt-4o-mini',
      sessionRepository: repository,
      sessionEventStore: repository,
      defaultContext: {
        metadata: { tenantId: principal.tenantId },
      },
    };
  },
  requirePersistentSessions: true,
  telemetry: new OpenTelemetryAgentServerTelemetry(),
});

// Mount this Fetch-compatible handler in the HTTP runtime.
export function handleAgentRequest(request: Request): Promise<Response> {
  return server.handle(request);
}
```

The JSONL adapter is suitable for a single Node.js host. A multi-instance
service must use one shared `runtimeStore`, or a shared `SessionRepository`,
`SessionEventStore`, and `AgentServerStore`. Every Store must partition data by
the authenticated `tenantId`. There is no trusted client-supplied tenant field.

See [Runtime Store](./runtime-store) for the PostgreSQL single-authority setup.

## SessionExecutor

`AgentServer` owns authentication, authorization, command idempotency, HTTP,
and SSE only. `SessionExecutor` owns Session creation, resume, fork, input,
abort, close, approval correlation, mutation serialization, and stream pumps.

When `sessionExecutor` is omitted, `AgentServer` creates an
`InProcessSessionExecutor` from `resolveSessionOptions`, preserving the original
in-process behavior:

```ts
import {
  AgentServer,
  InProcessSessionExecutor,
  InMemoryAgentServerStore,
} from '@blade-ai/agent-sdk/server';

const store = new InMemoryAgentServerStore();
const executor = new InProcessSessionExecutor({
  store,
  resolveSessionOptions,
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
});

const server = new AgentServer({
  store,
  sessionExecutor: executor,
  authenticate,
});
```

When a custom executor and `runtimeStore` are both configured, every command
receives the authenticated tenant's `RuntimeTenantStore` through
`SessionExecutorCommandContext.runtimeStore`. Custom executors must use that
Store as their persistence authority.

A custom executor must:

- Isolate active Sessions by tenant.
- Serialize mutations for each Session.
- Persist Session records and append stream, approval, and close events to the
  same Store used by `AgentServer`.
- Stop admission and release owned runtimes in `shutdown()`.
- Never expose provider credentials, internal failures, or non-JSON values in
  command results.

This port is the replacement boundary for remote workers, container executors,
and schedulers. It is not a tool adapter and does not grant local host access.

## HTTP API

The default base path is `/v1/agent`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/agent/commands` | Execute one protocol v1 command |
| `GET` | `/v1/agent/sessions/:sessionId/events` | SSE replay and live stream |
| `GET` | `/v1/agent/healthz` | Process liveness |
| `GET` | `/v1/agent/readyz` | `AgentServerStore` readiness |

The event endpoint accepts `?after=<sequence>` or standard `Last-Event-ID`,
with the query parameter taking precedence. Sequence numbers increase
monotonically within a Session. A cursor older than the Store retention window
returns `STALE_CURSOR`; the client never skips the missing range silently.

`AgentServer.handle()` requires `authenticate` to return a principal. Health
routes are unauthenticated. `execute(command, principal)` and
`events(principal, sessionId)` are available to already-authenticated in-process
transports.

## Browser client

```ts
import { AgentClient } from '@blade-ai/agent-sdk/browser';

const client = new AgentClient({
  baseUrl: 'https://api.example.com/v1/agent',
  client: { name: 'web-console', version: '1.0.0' },
  headers: async () => ({
    authorization: `Bearer ${await getAccessToken()}`,
  }),
});

// createSession accepts only metadata, persisted together with session.create
const session = await client.createSession({ origin: 'console' });
await session.send('Review today\'s deployment risks');

for await (const event of session.events()) {
  if (event.type === 'permission.requested') {
    await client.resolvePermission(
      session.sessionId,
      event.data.permissionRequestId,
      { approved: false, reason: 'Requires a staffed change window' },
    );
  }
  if (event.type === 'session.stream' && event.data.type === 'result') {
    break;
  }
}
```

`session.read` returns a `recovery` object alongside the session and its messages:
the route state, attempt, fencing token and worker when the Session is queued or
running, whether this server has the Session loaded, how many inputs are accepted
but not applied, and the last event sequence. A client that lost its own storage
can reattach from these facts instead of guessing, and it must treat `messages`
as unknown rather than empty when `loaded` is false.

`lastEventSequence` is where a reconnecting client resumes the stream, and it stops
at the **last completed request**. The message projection trails the event log
while a request runs — content deltas are published before the assistant message
is written — so a cursor equal to the event head would let a refreshed page skip
output the projection has not recorded yet. Stopping at the completed request
means the client replays the in-flight turn and deduplicates by event id, which
cannot lose content. The cursor is resolved before the snapshot is loaded, so the
two reads cannot race.

The search for that boundary is bounded: up to four trailing windows of 500 events
each. A boundary found inside them is used; when none is found the cursor falls
back to the start of what the log still retains, replaying more rather than
skipping the part that happened to fall outside the scan — a scan budget is not
history that may be skipped. A trimmed log clamps the cursor into the retained
range.

Whether a cursor is trustworthy also depends on the **message projection's own
progress**. The projection commits a `historyProgress` record together with each
message: a failed message write records a `state: 'failed'` gap, and later
successful requests never clear it — only the repair path can. While a gap exists
the server uses no boundary after it and replays from the start of what the log
retains; if the log was trimmed it also reports `recoveryIncomplete: true`, because
falling back recovers only what is still retained and is not claimed to be lossless.

`repairSessionHistory()` rebuilds the missing messages from the durable journal,
which is the authority: a request's accepted input (by `inputId`), a completed tool
attempt (by `toolCallId`), and the turn's assistant output (matched through the tool
calls it requested). Repair only writes data — it never re-runs a model call or a
tool — writes nothing on a second pass, and leaves the gap open with
`insufficient-durable-data` when the journal itself was trimmed.

That retained range comes from the store's `getEventStreamRange`, which is part of
the recovery guarantee: a custom store without it is never handed the event head as
a cursor. The server replays from `0` when the log is still readable from the
start, and when even that cannot be established (the log was trimmed) the recovery
object carries `recoveryIncomplete: true` and omits `lastEventSequence` instead of
offering a cursor that may skip content. When `loaded` is false the pending-input projection is unknown, so
`pendingInputCount` is omitted instead of reporting the unknown as zero.

`appendEvent(..., { idempotencyKey })` keeps its idempotency record for the
Session's lifetime, independent of event retention: a retry whose original event
has already been trimmed is still recognised as a repeat and returns that event.
7.4.4 and earlier stored the key as the event's own id with no separate record;
either shape is recognised and the legacy one is backfilled in place, so an
upgrade cannot publish an already-published terminal result again.

`AgentClient` generates a stable `commandId` and reuses it when retrying
network failures, HTTP 408, HTTP 429, and every 5xx response. Each command
method also accepts an explicit `commandId`. The SSE client reconnects from the
last sequence and stops after `session.closed`. One unserialised SSE frame is
bounded at 4 MiB (measured in UTF-8 bytes): the limit applies to every complete
frame, and to whatever remains buffered when a frame has no delimiter yet, so a
peer cannot grow the parser by streaming bytes without ever ending a frame.

## Protocol v1

Commands:

- `initialize`
- `session.create`
- `session.read`
- `session.list`
- `session.resume`
- `session.fork`
- `session.close`
- `input.submit`
- `request.abort`
- `permission.resolve`

Events:

- `session.stream`
- `permission.requested`
- `session.closed`

Every envelope carries `protocolVersion: 1` and is validated by a strict Zod
schema. Unknown fields, unknown commands, invalid identifiers, and unsupported
versions are rejected.

## Authorization

| Scope | Command |
|-------|---------|
| `session:create` | `session.create` |
| `session:read` | `session.read`, `session.list`, and SSE (`session.fork` requires both `session:read` and `session:create`) |
| `session:write` | `session.resume`, `session.close`, `input.submit`, and `request.abort` |
| `permission:resolve` | `permission.resolve` |
| `session:admin` | Satisfies every scope |

Session records, command claims, event logs, and approvals are isolated by the
server principal's `tenantId`. Cross-tenant access returns
`SESSION_NOT_FOUND`, which avoids disclosing whether a Session exists.

## Idempotency and backpressure

The `AgentServerStore` command lifecycle is:

1. `claimCommand()` claims the command ID.
2. `sealCommand()` makes the claim non-expiring before side effects.
3. `completeCommand()` persists the deterministic result.

If step three fails, the server returns `COMMAND_IN_PROGRESS` and leaves the
command sealed. It never uses a TTL to replay a side effect with an unknown
outcome. A production Store must implement claim, seal, and complete atomically.
Each claim also stores a SHA-256 fingerprint of the command payload. Reusing a
`commandId` for a different payload returns non-retryable `COMMAND_CONFLICT`;
the Store does not retain prompt text.

SSE uses a pull-based `ReadableStream`, emits at most one frame per pull, and
sets `highWaterMark` to 1. Slow clients cannot cause unbounded server-side
enqueueing. Event retention must be bounded; once a cursor falls behind that
window, `STALE_CURSOR` tells the client to reload Session state.

## Storage responsibilities

| Port | Source of truth |
|------|-----------------|
| `SessionRepository` | Read-only transcript state/message projection, fork, and list |
| `SessionEventStore` | Transcript domain event appends |
| `AgentServerStore` | Tenant Session records, command idempotency, and remote event replay |
| `DurableEventStore` | Request, Turn, model, and tool lifecycle journal and recovery |

These ports have different responsibilities. A production implementation may
place them in one database, but must not partially commit a boundary that
requires both. When multiple workers may open the same Session, configure a
fencing-capable `DurableExecutionLeaseStore` and a unique
`executionLease.ownerId` for each worker.

The included `InMemoryAgentServerStore` is for one process and tests only. It
does not provide cross-process idempotency, global quotas, or highly available
event replay.

## Admission, approvals, and telemetry

Defaults per tenant:

| Limit | Default |
|-------|--------:|
| Concurrent commands | 8 |
| Queued commands | 64 |
| Commands per minute | 600 |
| Active Sessions | 100 |

A full queue returns `OVERLOADED`; a rate violation returns `RATE_LIMITED` with
`retryAfterMs`. Aborted requests are removed from the wait queue.

Tool confirmation is published as `permission.requested` and completed with a
`permission.resolve` command. Pending approvals are isolated by tenant, Session,
approver `subject`, and `permissionRequestId`, and are cancelled on timeout,
request abort, Session close, or server close.

`OpenTelemetryAgentServerTelemetry` records:

- `blade.agent.server.commands`
- `blade.agent.server.command.duration`
- `blade.agent.server.events`
- `blade.agent.server.command` spans

Metrics and spans omit prompts, tool arguments, provider credentials, subjects,
and tenant IDs by default. Only `includeTenantAttributes: true` emits a tenant
attribute. The `auditSink` receives command metadata and outcomes, never input
payloads.

## Production checklist

- Derive tenant and subject from authentication; never trust client identity fields.
- Use a shared, atomic, persistent `AgentServerStore`.
- Use a shared `SessionRepository` partitioned by tenant.
- Configure a durable event store and execution lease for multi-worker Sessions.
- Disable SSE buffering at the reverse proxy and set its idle timeout above the heartbeat.
- Enforce CORS, CSRF, cookie, and token policy before `handle()`.
- Alert on `COMMAND_IN_PROGRESS`; it requires reconciliation, not blind replay.
- Define separate retention policies for events, Sessions, and audit records.
- Stop new traffic before shutdown, then hand off or explicitly close Sessions.
