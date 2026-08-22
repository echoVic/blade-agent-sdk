# Durable Event Store

Durable Event Store is the first foundation for a recoverable execution
runtime. It provides a stable event envelope, monotonic per-Session sequences,
compare-and-append, and cursor-based reads.

::: warning Integration status
This phase does not change `Session.send()`, `Session.stream()`, or the existing
Session JSONL format. Applications can use the Event Store directly; Session
lifecycle events will be connected in a later phase.
:::

## Imports

Protocol types and parsers are available from root and the browser-safe `/core`
entry. The Node.js JSONL adapter is available from root and `/local`:

```ts
import {
  CommandId,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  RequestId,
  SessionId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope {
  schemaVersion: 1;
  eventId: EventId;
  sequence: EventSequence;
  sessionId: SessionId;
  type: DurableEventType;
  data: JsonObject;
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

Version 1 reserves Session, Request, Turn, Tool, Permission, and input lifecycle
event names. Payloads are strict `JsonObject` values; later phases will add
per-event discriminated payload types.

| Scope | Events |
|-------|--------|
| Session | `session_created`, `session_closed` |
| Request | `request_accepted`, `request_started`, `request_completed`, `request_failed`, `request_interrupted` |
| Turn | `turn_started`, `turn_completed`, `turn_aborted` |
| Tool | `tool_scheduled`, `tool_started`, `tool_completed`, `tool_failed`, `tool_cancelled`, `tool_outcome_unknown` |
| Permission | `permission_requested`, `permission_resolved` |
| Input | `input_applied` |

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
      type: DurableEventType.REQUEST_ACCEPTED,
      requestId,
      commandId,
      data: {
        inputId,
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
console.log(result.lastSequence);     // 2
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
Phase one does not provide automatic command deduplication.

The Store does not persist token deltas or high-frequency tool progress.
Only domain events that affect recovery decisions belong in the durable
journal.

## Errors

| Error | Meaning |
|-------|---------|
| `DurableEventSequenceConflictError` | Compare-and-append precondition failed. |
| `DurableEventStoreError` | Invalid input, cursor, I/O, or log integrity failure. |

A complete newline-terminated record with an invalid schema, duplicate ID, or
non-contiguous sequence is a corrupt log. The Store fails instead of skipping
it.
