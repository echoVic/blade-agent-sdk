# Durable Event Store

Durable Event Store is the foundation for a recoverable execution runtime. It
provides a stable event envelope, monotonic per-Session sequences,
compare-and-append, cursor-based reads, and deterministic Session lifecycle
projection.

::: warning Integration status
Session writes durable events only when
`SessionOptions.durableEventStore` is explicitly set; the existing message JSONL
format is unchanged. `resumeSession()` automatically restores a Request that
was accepted but did not cross the `request_started` boundary. An active Turn
must first be atomically rolled over through the Recovery Coordinator; pending
permissions and unknown tool outcomes still require explicit resolution. A
`non_idempotent` tool is never replayed automatically.
:::

## Imports

Protocol types and parsers are available from root and the browser-safe `/core`
entry. The Node.js JSONL adapter is available from root and `/local`:

```ts
import {
  CommandId,
  DurableEventSubscription,
  type DurableEventDataMap,
  DurableSessionRecoveryCoordinator,
  DurableSessionProjector,
  DurableSessionJournal,
  DurableEventType,
  EventSequence,
  InputId,
  JsonlDurableEventStore,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope<TType extends DurableEventType> {
  schemaVersion: 2;
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
| `request_accepted` | `requestId`, `commandId` | `inputId`, `input`, `priority`, `maxTurns?`, `model?`, `context?`, `recovery?` |
| `request_started` | `requestId` | Empty object |
| `request_completed` | `requestId` | `output?`, `usage?` |
| `request_failed` | `requestId` | `error` |
| `request_interrupted` | `requestId` | `reason`, `byInputId?` |
| `turn_started` | `requestId`, `turnId` | `turn`, `model?` |
| `turn_completed` | `requestId`, `turnId` | `turn`, `hasToolCalls` |
| `turn_aborted` | `requestId`, `turnId` | `turn`, `reason` |
| `tool_scheduled` | Request, Turn, `toolAttemptId` | `toolCallId`, `toolName`, `input`, `sideEffect`, `interruptBehavior` |
| `tool_started` | Request, Turn, `toolAttemptId` | Tool identity, final `input`, resolved `sideEffect` |
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
Commands derived from the current projection should pin the observed head with
`expectedHeadSequence` so stale decisions cannot commit after either local or
external writers advance the state. The Recovery Coordinator enforces this for
all recovery commands; the same command committed by a competitor still
returns `reconciled`.

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

## Reconnectable event subscriptions

`DurableEventSubscription` wraps cursor-based reads in a pull-based
`AsyncIterableIterator`. It captures a replay head when opened, replays events
through that position, emits one `caught_up` barrier, and then marks later
events as `live`:

```ts
const subscription = await DurableEventSubscription.open(store, sessionId, {
  after: savedCursor,
  pageSize: 100,
  pollIntervalMs: 250,
});

for await (const message of subscription) {
  if (message.type === 'caught_up') {
    markClientReady(message.headSequence);
    continue;
  }

  await deliver(message.event);
  await saveCursor(message.cursor);
}
```

The same subscription is available from an initialized Session:

```ts
const subscription = await session.subscribeDurableEvents({
  after: savedCursor,
});
```

A cursor is a strictly versioned JSON value containing `sessionId`, `sequence`,
and `eventId`. Reconnection verifies that the cursor still names the same event
in the canonical log. A foreign, ahead-of-head, replaced, or sequence-gapped
cursor fails closed instead of skipping data.

The subscription reads another page only when the consumer asks for another
item, bounding memory and read pressure by `pageSize`. It ends after
`session_closed`; `close()` cleanly releases a pending wait, while an
`AbortSignal` terminates with `AbortError`. Set `follow: false` to replay only
the snapshot that existed when the subscription opened. Persist each delivery's
cursor only after processing the event to obtain at-least-once delivery across
reconnections.

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
| `resume_turn` | A model call, scheduled tool, or safely replayable started tool can continue. |
| `resolve_permissions` | Pending permissions must be presented again or resolved by policy. |
| `reconcile_tool_outcomes` | A tool started without a reliable terminal outcome and must not be retried automatically. |

The plan also separates `retryableToolAttempts`, `cancelableToolAttempts`,
`unknownToolAttempts`, and `pendingPermissions`. Started or
`tool_outcome_unknown` tools declared `pure` or `idempotent` are retryable.
`non_idempotent` tools remain unknown and require external reconciliation with
`tool_completed`, `tool_failed`, or `tool_cancelled`; the projector does not
allow the Turn to end before then.

## Recovery Coordinator

`DurableSessionRecoveryCoordinator` adds constrained state mutations above the
projector's recovery classification:

```ts
const coordinator = await DurableSessionRecoveryCoordinator.open(
  store,
  sessionId,
);

const decision = coordinator.planResume();
if (decision.action === 'resume_accepted_request') {
  console.log(decision.request.input);
}

await coordinator.reconcileToolOutcome({
  commandId: CommandId('reconcile-deploy-42'),
  toolAttemptId: ToolAttemptId('attempt-42'),
  outcome: {
    status: 'completed',
    result: { deploymentId: 'dep-42' },
  },
});
```

`reconcileToolOutcome()` accepts only a Tool Attempt still addressable by the
current projection and inherits the Journal's command idempotency and CAS
semantics. Callers can explicitly record `completed`, `failed`, or `cancelled`
and must reuse the same `commandId` when retrying an operation.

Resolve a pending permission with `resolvePermission()`. A `deny` or `cancel`
decision commits `permission_resolved` and the matching `tool_cancelled` in one
command/batch, so observers never see a denied permission with a scheduled tool:

```ts
await coordinator.resolvePermission({
  commandId: CommandId('deny-deploy-42'),
  permissionRequestId: PermissionRequestId('permission-42'),
  decision: 'deny',
  message: 'Deployment window closed',
});
```

After resolving a permission as `allow`, the application must call and await
`startToolAttempt({ commandId, toolAttemptId })` before running the exact input
returned in the updated projection. The method only uses persisted operation
facts and commits `tool_started` as a separate idempotent command, preserving
the persist-before-side-effect boundary. A tool resumed after a permission
round-trip is conservatively classified as `non_idempotent`; callers cannot
downgrade its side-effect class during recovery. A `pure` or `idempotent` tool
already in `started` state may be replayed and then settled with
`reconcileToolOutcome()`. A started `non_idempotent` tool must only be
reconciled after querying the external system and must not be executed again.

`planResume()` returns `resume_accepted_request` only when the accepted Request
has no `input_applied` or `request_started` boundary and carries a complete
execution snapshot. Session resumes the same `requestId` using the durable
input and persisted `maxTurns`, model, and Runtime Context. A legacy Request
without that snapshot, or a started Request even without an active Turn, returns
`recovery_required`. This avoids executing under different settings or
duplicating a model call that may already have completed.

For `resume_turn`, `prepareTurnRecovery()` performs these transitions in one
CAS command:

1. cancel `pure` / `idempotent` or not-yet-started tools without a trusted
   terminal outcome;
2. terminate the old Turn and Request with `process_restart`;
3. accept a new continuation Request containing the original input, durable
   tool outcomes, and source Request/Turn provenance.

The continuation marks tools that never executed as `not_started` and
retry-safe tools that crossed the execution boundary as
`interrupted_before_trusted_completion`. Restored message history omits old
tool calls without paired results; the new user continuation carries the
durable recovery facts instead, avoiding both cross-store synthetic results
and provider-invalid dangling tool calls. Multimodal original inputs retain
their content parts instead of being flattened into JSON text. A permitted but
not-yet-started tool uses the permission-updated input and is conservatively
classified as `non_idempotent`.

```ts
await coordinator.prepareTurnRecovery({
  commandId: CommandId('recover-turn-42'),
  requestId: RequestId('request-source-42'),
  turnId: TurnId('turn-source-42'),
  recoveryRequestId: RequestId('request-recovery-42'),
  recoveryInputId: InputId('input-recovery-42'),
});

const session = await resumeSession({
  ...options,
  sessionId,
});
for await (const event of session.stream()) {
  // The new accepted Request uses the existing resume path.
}
```

The entire rollover can be retried with the same `commandId`, and competing
processes can commit it only once. Provenance is valid only when the same
command contains the adjacent `turn_aborted -> request_interrupted ->
request_accepted` transition. `requestId` and `turnId` are preconditions for
the state observed by the caller, so the command cannot silently target a
newer active Turn. A `non_idempotent` tool that is `completed`, `failed`, or
`cancelled` after execution started raises
`DURABLE_RECOVERY_UNSAFE_ROLLOVER` and remains fail-closed; the API does not use
prompting to bypass an unknown side effect.

Schema v2 adds the required `sideEffect` field to `tool_scheduled`. Version 1
logs are not inferred silently and must be migrated before this runtime can
resume them.

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
Events contain raw request inputs, tool inputs, and model-facing tool results.
Treat the Store as sensitive data and configure encryption, retention, and
access control at the deployment boundary.

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
| `DurableEventSubscriptionError` | Subscription options, cursor anchors, or Store pages violate the replay contract. |
| `DurableSessionRecoveryRequiredError` | The Session has unfinished work that requires recovery or reconciliation. |
| `SessionDurableRecorderError` | Session runtime observed an invalid durable lifecycle state. |
| `DurableEventProjectionError` | Schema, ordering, or correlation violates lifecycle invariants. |
| `DurableEventSequenceConflictError` | Compare-and-append precondition failed. |
| `DurableEventStoreError` | Invalid input, cursor, I/O, or log integrity failure. |

A complete newline-terminated record with an invalid schema, duplicate ID, or
non-contiguous sequence is a corrupt log. The Store fails instead of skipping
it.
