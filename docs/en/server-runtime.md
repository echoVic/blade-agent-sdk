# Server Runtime

`AgentServer` exposes server-profile Sessions through a versioned command API
and a replayable SSE event stream. Browsers use `AgentClient`; they never load
model providers, tool executors, or local host capabilities.

## Runtime boundaries

| Entry | Responsibility |
|-------|----------------|
| `@blade-ai/agent-sdk/server/infra` | `AgentServer`, Workers, Stores, tenant admission, and telemetry |
| `@blade-ai/agent-sdk/browser` | `AgentClient`, protocol schemas, parsers, and errors |
| `@blade-ai/agent-sdk/advanced` | Low-level Sessions, local JSONL, file, shell, and sandbox adapters |

The server profile never interprets `storagePath` as permission to access local files.
A resumable Session requires an explicitly supplied `sessionRepository` and
`sessionEventStore`, or one `runtimeStore`. Set
`requirePersistentSessions: true` to fail closed on incomplete configuration.

## Create a server

```ts
import {
  AgentServer,
  type AgentPrincipal,
} from '@blade-ai/agent-sdk/server/infra';
import { JsonlSessionRepository } from '@blade-ai/agent-sdk/advanced';

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

### Built-in tools

`builtinTools: true` registers every built-in tool the SDK ships — not only
filesystem, search and shell, but also `Write`, `Edit`, `NotebookEdit`,
`WebFetch`, `WebSearch`, the `Task` subagent family, `TodoWrite`, memory, plan
mode and skills. `allowedTools` is the only thing that narrows that set.
Server-hosted Sessions do not register any of it by default: the server
process is shared by every tenant, so an operator must opt in explicitly —
and, in the same call, set `allowedTools`, or the opt-in hands that tenant
file writes and outbound network access from the server process. Scope the
result further with `defaultContext.capabilities.filesystem` for visible
directories and `permissions` and `sandbox` for each call:

```ts
resolveSessionOptions() {
  return {
    provider,
    model,
    builtinTools: true,
    // Required: without allowedTools, builtinTools: true registers every
    // built-in tool, including Write, Edit, WebFetch and WebSearch.
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    permissions: { allow: ['Read', 'Read:*', 'Glob', 'Glob:*', 'Grep', 'Grep:*'] },
    sandbox: { enabled: true },
    defaultContext: { capabilities: { filesystem: { roots: [workspace], cwd: workspace } } },
  };
}
```

The `defaultContext.capabilities.filesystem` roots only bound the tools that
take a path argument — `Read`, `Glob`, and `Grep`. `Bash` is not one of them:
it only requires a working directory to exist and never checks the command or
the working directory against the roots, so `Bash`'s reach is bounded by
`sandbox` and `permissions` instead. Setting `sandbox: { enabled: true }` on a
host with no platform sandbox makes Session initialization fail outright,
rather than falling back to running unsandboxed. The capability check a
caller would use to predict that failure ahead of time (`canUseSandbox()`)
reports whether the platform has a supported sandbox, not whether a sandboxed
command will actually run — the underlying seatbelt or Bubblewrap profile can
still be rejected at run time. A caller that must not fail closed should not
trust the capability check alone; probe by running one trivial command
through the sandbox wrapper first, the way the starter does before it enables
its own sandbox.

Local Sessions still register the built-in tools by default; set
`builtinTools: false` to turn them off. Skill and subagent disk discovery only
ever runs on the local host — a server never scans the host's disk.

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
} from '@blade-ai/agent-sdk/server/infra';

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

Whether a cursor is trustworthy depends on the **message projection's own
progress**, not on the event log. The projection commits a `historyProgress`
record together with each message. A failed message write records a
`state: 'failed'` gap, and later successful requests never clear it — only the
repair path can. The record also carries `coveredRequestId`: the newest request
whose content the projection already holds. The transcript and the event log are
separate stores that share no sequence, so the request is the only identity both
of them carry — the server turns it into a cursor by finding that request in the
log. Because the boundary comes from the snapshot, a request that completes
between the snapshot read and the cursor resolution cannot move it.

A projection without a coverage record falls back to the bounded search, and that
search is itself bounded by the event head observed *before* the snapshot was
taken, so a request that finishes mid-read is excluded as well. While a gap exists
the server uses no boundary after it and replays from the start of what the log
retains; if the log was trimmed, or the projection reports a gap, it also reports
`recoveryIncomplete: true`, because falling back recovers only what is still
retained and is not claimed to be lossless.

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
| `SessionEventStore` | Atomic transcript projection updates |
| `AgentServerStore` | Tenant Session records, command idempotency, and remote event replay |
| `DurableEventStore` | Request, Turn, model, and tool lifecycle journal and recovery |

These ports have different responsibilities. A production implementation may
place them in one database, but must not partially commit a boundary that
requires both. When multiple workers may open the same Session, configure a
fencing-capable `DurableExecutionLeaseStore` explicitly through
`durableExecutionLeaseStore`, plus a unique `executionLease.ownerId` for each
worker.

The included `InMemoryAgentServerStore` is for one process and tests only. It
does not provide cross-process idempotency, global quotas, or highly available
event replay.

### Single-process file store

`JsonlAgentServerStore` appends session records, the event log, idempotency
keys and command leases to `<directory>/server-store.jsonl`, replaying and
compacting it on start. It keeps every semantic of the in-memory store and adds
one thing: Sessions survive a restart of the same process on the same machine.
Use it for local development, demos and single-instance deployments; multiple
instances still need the PostgreSQL store.

```ts
import { AgentServer, JsonlAgentServerStore } from '@blade-ai/agent-sdk/server/infra';

const store = new JsonlAgentServerStore({ directory: '.blade/server' });
await store.initialize();
const server = new AgentServer({ store, resolveSessionOptions });
// on exit
await server.close();
await store.close();
```

Writes reach the operating system before the mutating call resolves, so a
process crash keeps every acknowledged write; there is no fsync per write. A
truncated last line is skipped with a warning; any other damage fails
`initialize()` with `RUNTIME_STORE_CORRUPT_JOURNAL` and a line number. Delete
the directory to start from an empty store; Session transcripts kept by
`JsonlSessionRepository` live elsewhere and are not affected. Transcripts still
need `sessionRepository` / `sessionEventStore` configured separately.

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

`AgentServerTelemetry` is an explicit injection port with `recordCommand()`,
`recordEvent()`, and `writeAudit()`. The SDK does not bind a telemetry backend;
applications can connect the port to OpenTelemetry or an existing monitoring
system. Callbacks receive command and event metadata plus outcome state, never
prompts, tool arguments, or provider credentials.

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
