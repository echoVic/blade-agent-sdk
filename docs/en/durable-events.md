# Durable Event Store

Durable Event Store is the foundation for a recoverable execution runtime. It
provides a stable event envelope, monotonic per-Session sequences,
compare-and-append, cursor-based reads, and deterministic Session lifecycle
projection.

::: warning Integration status
The current phase does not change `Session.send()`, `Session.stream()`, or the
existing Session JSONL format. Applications can use the Event Store and recovery
projector directly; Session lifecycle events will be connected in a later phase.
:::

## Imports

Protocol types and parsers are available from root and the browser-safe `/core`
entry. The Node.js JSONL adapter is available from root and `/local`:

```ts
import {
  CommandId,
  type DurableEventDataMap,
  DurableSessionProjector,
  DurableSessionJournal,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  PermissionRequestId,
  RequestId,
  SessionId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope<TType extends DurableEventType> {
  schemaVersion: 1;
  eventId: EventId;
  sequence: EventSequence;
  sessionId: SessionId;
  type: TType;
  data: DurableEventDataMap[TType];
  recordedAt: string;
  occurredAt: string;
  commandId?: CommandId;
  requestId?: RequestId;
  turnId?: TurnId;
  toolAttemptId?: ToolAttemptId;
  causationEventId?: EventId;
}
```

- `eventId` identifies one event.
- `sequence` starts at 1 and increases strictly within a Session.
- `recordedAt` is the Store commit time.
- `occurredAt` is the domain occurrence time and defaults to `recordedAt`.
- Correlation fields use branded IDs to prevent accidental ID mixing.

Each event has a dedicated strict payload. Its required envelope correlation IDs
form the `DurableEventDraft` and `DurableEventEnvelope` discriminated unions.
Unknown fields, missing scope IDs, invalid enum values, and non-finite numbers
are rejected before append.

| Event | Required scope | Key payload |
|-------|----------------|-------------|
| `session_created` | Session | `source?`, `parentSessionId?` |
| `session_closed` | Session | `reason` |
| `request_accepted` | `requestId`, `commandId` | `inputId`, `input`, `priority` |
| `request_started` | `requestId` | Empty object |
| `request_completed` | `requestId` | `output?`, `usage?` |
| `request_failed` | `requestId` | `error` |
| `request_interrupted` | `requestId` | `reason`, `byInputId?` |
| `turn_started` | `requestId`, `turnId` | `turn`, `model?` |
| `turn_completed` | `requestId`, `turnId` | `turn`, `hasToolCalls` |
| `turn_aborted` | `requestId`, `turnId` | `turn`, `reason` |
| `tool_scheduled` | Request, Turn, `toolAttemptId` | `toolCallId`, `toolName`, `input`, `interruptBehavior` |
| `tool_started` | Request, Turn, `toolAttemptId` | `toolCallId`, `toolName` |
| `tool_completed` | Request, Turn, `toolAttemptId` | Tool identity, `result` |
| `tool_failed` | Request, Turn, `toolAttemptId` | Tool identity, `error` |
| `tool_cancelled` | Request, Turn, `toolAttemptId` | Tool identity, `reason` |
| `tool_outcome_unknown` | Request, Turn, `toolAttemptId` | Tool identity, `reason` |
| `permission_requested` | Request, Turn, `toolAttemptId` | `permissionRequestId`, tool identity, `input` |
| `permission_resolved` | Request, Turn, `toolAttemptId` | `permissionRequestId`, `decision` |
| `input_applied` | `requestId`, optional `turnId` | `inputId`, `priority` |

## Append events

```ts
const store = new JsonlDurableEventStore('/var/lib/my-agent');
const sessionId = SessionId('session-123');
const requestId = RequestId('request-123');
const commandId = CommandId('command-123');
const inputId = InputId('input-123');

const result = await store.append(
  sessionId,
  [
    {
      type: DurableEventType.SESSION_CREATED,
      data: { source: 'create' },
    },
    {
      type: DurableEventType.REQUEST_ACCEPTED,
      requestId,
      commandId,
      data: {
        inputId,
        input: 'Run the deployment checks',
        priority: 'next',
      },
    },
    {
      type: DurableEventType.REQUEST_STARTED,
      requestId,
      data: {},
    },
  ],
  {
    expectedLastSequence: null,
  },
);

console.log(result.previousSequence); // null
console.log(result.lastSequence);     // 3
```

One `append()` call is stored as one batch. The Store validates every draft and
assigns contiguous sequences before writing.

## Compare-and-append

`expectedLastSequence` provides optimistic concurrency:

| Value | Meaning |
|-------|---------|
| `undefined` | Append after the current head. |
| `null` | Require an empty event stream. |
| `EventSequence(n)` | Require the current head to equal `n`. |

A failed precondition throws `DurableEventSequenceConflictError` with expected
and actual sequence values.

```ts
await store.append(sessionId, events, {
  expectedLastSequence: EventSequence(12),
});
```

## Command journal

Production code should commit lifecycle events through `DurableSessionJournal`.
The Journal adds these guarantees above the Store:

- serialized commits within each instance;
- lifecycle transition preview before persistence;
- one caller-provided `commandId` stamped onto every event;
- bounded refresh and retry after explicit CAS conflicts;
- idempotent replay of an identical command;
- read-after-failure reconciliation after `DURABLE_EVENT_WRITE_FAILED`.

```ts
const journal = await DurableSessionJournal.open(store, sessionId);

const committed = await journal.commit({
  commandId: CommandId('create-session-123'),
  events: [
    {
      type: DurableEventType.SESSION_CREATED,
      data: { source: 'create' },
    },
  ],
});

console.log(committed.status); // committed | replayed | reconciled
console.log(journal.getProjection().status); // open
```

Submitting the same `commandId` and identical events returns `replayed` without
appending another copy. Reusing the command ID with different content throws
`DurableCommandConflictError`. A command's events must be contiguous in the
journal; the same ID appearing in separate ranges is also a conflict.

After a lower-level write error, the Journal reloads the canonical log:

- A complete matching command returns `reconciled`.
- A missing command or failed reload throws
  `DurableCommandOutcomeUnknownError` without an automatic retry.

The latter case requires reconciliation by the caller or a higher-level recovery
coordinator. An automatic retry could duplicate a write that succeeded but is
not yet visible. The Journal records `getUncertainCommandId()` in memory and
rejects different commands; submitting the same command can only trigger another
read reconciliation. `maxConflictRetries` applies only to explicit
compare-and-append conflicts, not unknown outcomes.

## Cursor reads

```ts
const page = await store.read(sessionId, {
  after: EventSequence(20),
  limit: 100,
});

for (const event of page.events) {
  consume(event);
}

console.log(page.nextCursor);
console.log(page.headSequence);
console.log(page.hasMore);
```

`after` is exclusive. Page size must be between 1 and 1000. A cursor ahead of
the current head is rejected rather than silently returning an empty page.

## State projection and recovery classification

`DurableSessionProjector` consumes events page by page.
`projectDurableSession()` is the one-shot convenience function. The projector
rechecks every lifecycle invariant instead of trusting compile-time types:

```ts
const projector = new DurableSessionProjector();
let after: EventSequence | undefined;

do {
  const page = await store.read(sessionId, { after, limit: 100 });
  projector.apply(page.events);
  after = page.nextCursor ?? undefined;
  if (!page.hasMore) break;
} while (true);

const projection = projector.snapshot();
const recovery = projector.recoveryPlan();
```

The projector fails closed and verifies at least these invariants:

- The first event creates the Session, and no lifecycle event follows closure.
- A Session has at most one active Request, and a Request has at most one active Turn.
- Request, Turn, Tool Attempt, Permission Request, Command, and applied Input IDs are not reused.
- Turn numbers are contiguous, and correlated Session, Request, Turn, and Tool identities match.
- Permission decisions finish before `tool_started`; unfinished tools prevent Turn completion.
- `causationEventId` only references an earlier event in the same journal.

After any validation failure, the projector instance remains failed. Discard it,
repair the canonical journal, and replay from the beginning rather than skipping
the invalid event.

`recoveryPlan()` returns one of these actions:

| Action | Meaning |
|--------|---------|
| `none` | No unfinished work exists. |
| `resume_request` | A Request was accepted without an active Turn and can restart. |
| `resume_turn` | A model call or tool that never started can continue from the durable boundary. |
| `resolve_permissions` | Pending permissions must be presented again or resolved by policy. |
| `reconcile_tool_outcomes` | A tool started without a reliable terminal outcome and must not be retried automatically. |

The plan also separates `retryableToolAttempts`, `cancelableToolAttempts`,
`unknownToolAttempts`, and `pendingPermissions`. An external reconciliation can
resolve `tool_outcome_unknown` with `tool_completed`, `tool_failed`, or
`tool_cancelled`; the projector does not allow the Turn to end before then.

## JSONL persistence

Files are stored under:

```text
{storageRoot}/durable-events/{base64url(sessionId)}.jsonl
```

Each line is a complete append batch rather than one event. If the process
stops during a write, recovery ignores the final batch unless it ends with a
newline, so a partial transaction is never accepted.

Each append:

1. rereads and validates the current head under a process-wide mutex;
2. checks the compare-and-append precondition;
3. assigns contiguous sequences and writes one batch;
4. calls file `fsync` before reporting success.

Event files use mode `0600`. Session IDs are base64url encoded and cannot
become filesystem paths.

## Consistency boundary

`JsonlDurableEventStore` serializes multiple Store instances within one Node.js
process. It does not provide cross-process fencing. Multi-process or replicated
services must implement `DurableEventStore` with database transactions, CAS,
or an execution lease.

`DURABLE_EVENT_WRITE_FAILED` does not prove that a batch was not written. A
write can reach the file before `fsync` reports failure. Before retrying, read
the head and correlate events through `commandId` or another domain identifier.
The current Store does not provide automatic command deduplication.

The Store does not persist token deltas or high-frequency tool progress.
Only domain events that affect recovery decisions belong in the durable
journal.

## Errors

| Error | Meaning |
|-------|---------|
| `DurableCommandConflictError` | One `commandId` maps to different content or non-contiguous ranges. |
| `DurableCommandOutcomeUnknownError` | A failed write cannot be reconciled and the Journal is fenced. |
| `DurableSessionJournalError` | Command input, Store page, or commit result violates its contract. |
| `DurableEventProjectionError` | Schema, ordering, or correlation violates lifecycle invariants. |
| `DurableEventSequenceConflictError` | Compare-and-append precondition failed. |
| `DurableEventStoreError` | Invalid input, cursor, I/O, or log integrity failure. |

A complete newline-terminated record with an invalid schema, duplicate ID, or
non-contiguous sequence is a corrupt log. The Store fails instead of skipping
it.
