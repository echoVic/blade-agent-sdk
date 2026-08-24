# Durable Event Store

Durable Event Store is the foundation for a recoverable execution runtime. It
provides a stable event envelope, monotonic per-Session sequences,
compare-and-append, cursor-based reads, and deterministic Session lifecycle
projection.

::: warning Integration status
Session writes durable events only when
`SessionOptions.durableEventStore` is explicitly set; the existing message JSONL
format is unchanged. `resumeSession()` automatically restores a Request that
was accepted but did not cross the `request_started` boundary. A started
Request without a Turn, and an active Turn, must first be atomically rolled
over through the Recovery Coordinator. Pending permissions, unknown tool or
model outcomes, and Requests whose latest Turn finished without a Request
terminal event still require explicit resolution. A `non_idempotent` tool or
model call with an unknown outcome is never replayed automatically.
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
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  TurnId,
} from '@blade-ai/agent-sdk';
```

## Event envelope

```ts
interface DurableEventEnvelope<TType extends DurableEventType> {
  schemaVersion: 2 | 3;
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
  modelAttemptId?: ModelAttemptId;
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
| `model_request_started` | Request, Turn, `modelAttemptId` | `model`, `streaming` |
| `model_request_completed` | Request, Turn, `modelAttemptId` | Complete model `response` |
| `model_request_failed` | Request, Turn, `modelAttemptId` | `error` |
| `model_request_aborted` | Request, Turn, `modelAttemptId` | `reason` |
| `tool_scheduled` | Request, Turn, `modelAttemptId`, `toolAttemptId` | `toolCallId`, `toolName`, `modelInput`, `input`, `sideEffect`, `interruptBehavior` |
| `tool_started` | Request, Turn, `toolAttemptId` | Tool identity, final `input`, resolved `sideEffect` |
| `tool_completed` | Request, Turn, `toolAttemptId` | Tool identity, `result` |
| `tool_failed` | Request, Turn, `toolAttemptId` | Tool identity, `error` |
| `tool_cancelled` | Request, Turn, `toolAttemptId` | Tool identity, `reason` |
| `tool_outcome_unknown` | Request, Turn, `toolAttemptId` | Tool identity, `reason` |
| `permission_requested` | Request, Turn, `toolAttemptId` | `permissionRequestId`, tool identity, `input` |
| `permission_resolved` | Request, Turn, `toolAttemptId` | `permissionRequestId`, `decision` |
| `input_applied` | `requestId`, optional `turnId` | `inputId`, `priority` |

`request_accepted.recovery` always retains the v2
`{ requestId, turnId, turn }` wire shape. A pre-Turn Request rollover writes a
synthetic Turn in the same command to provide provenance. The projector exposes
that meaning as `recoveryKind: 'pre_turn_request'` without adding fields to the
persistent recovery object.

## Append events

```ts
const store = new JsonlDurableEventStore('/var/lib/my-agent');
// Optional: bound lock acquisition and the complete Store call separately.
const boundedWaitStore = new JsonlDurableEventStore('/var/lib/my-agent', {
  lockTimeoutMs: 15_000,
  operationTimeoutMs: 30_000,
});
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
- An `input_applied.turnId`, when present, matches the active Turn.
- Request-terminal causation, when present, points to that Request's latest
  persisted boundary, such as `request_accepted`, `request_started`,
  `input_applied`, or a terminal Turn event.
- Permission decisions finish before `tool_started`; unfinished tools prevent Turn completion.
- `causationEventId` only references an earlier event in the same journal.

After any validation failure, the projector instance remains failed. Discard it,
repair the canonical journal, and replay from the beginning rather than skipping
the invalid event.
For compatibility with existing schema-v2 journals, an absent Request-terminal
causation remains readable. The current Session writer binds every standalone
Request terminal event to the latest Request boundary, while
`reconcileRequestOutcome()` binds the caller-confirmed terminal Turn event.
Journal preview rejects new unanchored or stale-boundary writes. An adjacent
Turn/Request termination in one command does not need to reference an event ID
that has not been allocated yet. Writers that bypass Journal and append to the
Store directly must preserve the same contract themselves.

`recoveryPlan()` returns one of these actions:

| Action | Meaning |
|--------|---------|
| `none` | No unfinished work exists. |
| `resume_request` | A Request was accepted but not started and can resume in place. |
| `rollover_request` | A Request started before its first Turn and can safely roll into a new Request. |
| `resume_turn` | The Turn has not called the model, or its model outcome is known and tools can continue safely. |
| `resolve_permissions` | Pending permissions must be presented again or resolved by policy. |
| `reconcile_tool_outcomes` | A tool started without a reliable terminal outcome and must not be retried automatically. |
| `reconcile_model_outcome` | A model request started without a reliable terminal outcome and must be reconciled against provider or application records. |
| `reconcile_request_inputs` | The applied-input set before the first Turn is ambiguous and requires explicit reconciliation. |
| `reconcile_request_outcome` | A Turn ended without a Request terminal event, so the final outcome must be reconciled. |

The plan also exposes `activeModelAttempt` and separates
`retryableToolAttempts`, `cancelableToolAttempts`, `unknownToolAttempts`, and
`pendingPermissions`. Started or
`tool_outcome_unknown` tools declared `pure` or `idempotent` are retryable.
`non_idempotent` tools remain unknown and require external reconciliation with
`tool_completed`, `tool_failed`, or `tool_cancelled`; the projector does not
allow the Turn to end before then.

Model calls use independent `ModelAttemptId` values. Session commits
`model_request_started` before calling the provider, then commits
`model_request_completed`, `model_request_failed`, or
`model_request_aborted` after the call settles. An active model attempt blocks
Turn termination. If a process stops with a started attempt, the plan returns
`reconcile_model_outcome` instead of treating a possibly completed or billed
call as if it never happened.
A model attempt is one logical model operation and may contain internal HTTP
retries. A reactive-compaction retry creates a new attempt. High-frequency
token deltas remain transient, while the complete response is durable before
any later Turn terminal event.
Active model reconciliation takes precedence over permission and tool outcomes
in the same Turn. After the model terminal event commits, the plan exposes the
next unresolved recovery action.

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

For a model call with an unknown outcome, inspect provider request logs or
application records and reconcile it explicitly. The command binds the
Request, Turn, and Model Attempt and uses Journal CAS to reject stale
decisions:

```ts
await coordinator.reconcileModelOutcome({
  commandId: CommandId('reconcile-model-42'),
  requestId: RequestId('request-42'),
  turnId: TurnId('turn-42'),
  modelAttemptId: ModelAttemptId('model-attempt-42'),
  outcome: {
    status: 'completed',
    response: {
      content: 'Inspected result',
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
      },
    },
  },
});
```

The caller may instead confirm `failed` or `aborted`. Only a reconciled Turn
can proceed to `prepareTurnRecovery()`. Its continuation carries bounded,
confirmed model responses together with tool outcomes, so an unknown provider
call is never silently reissued. Reuse the original `commandId` when retrying
the reconciliation.

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
without that snapshot continues to return `recovery_required`.

`request_started` is persisted before `UserPromptSubmit`, attachment expansion,
initial compaction, and AgentLoop's `turn_start`. Therefore, the absence of a
Turn proves only that no primary model call started; it does not prove that
pre-Turn hooks or other preparation had no side effects. The plan returns
`rollover_request` only when the durable `appliedInputIds` contain exactly the
initial input. A missing initial application or additional steering input
returns `reconcile_request_inputs`.
Both initial and steering inputs commit `input_applied` before their hooks and
attachment preparation. A failed commit prevents those side effects; a
successful commit prevents automatic replay even if preparation later fails.
If an input enters preparation between a completed Turn and the next Turn, the
plan also returns `reconcile_request_inputs`; `sourceLastTurn` binds rollover to
the Turn number observed by the caller.
This guarantee depends on writers preserving that order. If a custom or older
writer ran input side effects before `input_applied`, the journal cannot prove
their outcome and the caller must fail closed instead of continuing from
`rollover_request` alone.

Both actions converge through `prepareRequestRecovery()`, but the caller must
first reconcile the complete pre-Turn preparation stage, provide the final
prepared input, and echo the observed `activeRequest.appliedInputIds` exactly:

```ts
const request = coordinator.getProjection().activeRequest;
if (!request) throw new Error('No active Request');
const preparedInput = 'prepared input after external reconciliation';

await coordinator.prepareRequestRecovery({
  commandId: CommandId('recover-request-42'),
  requestId: RequestId('request-source-42'),
  inputId: InputId('input-source-42'),
  sourceLastTurn: request.lastTurn,
  recoveryTurnId: TurnId('synthetic-recovery-turn-42'),
  recoveryRequestId: RequestId('request-recovery-42'),
  recoveryInputId: InputId('input-recovery-42'),
  preparation: {
    status: 'reconciled',
    appliedInputIds: request.appliedInputIds ?? [],
    input: preparedInput,
  },
});
```

The API writes an optional `request_started` when the source is still accepted,
followed by
`turn_started (synthetic) -> turn_aborted -> request_interrupted ->
request_accepted` in one CAS command. The source Request/Input IDs,
`appliedInputIds`, and Journal head are preconditions. A concurrent real
`turn_started` or new input application makes the stale command fail. The
restored Session filters old pending inputs that were applied or reconciled and
skips `UserPromptSubmit`, attachment expansion, and the first `beforeTurn`
preparation, so the supplied `preparedInput` executes once. Original multimodal
content parts retain their structure.

When a Request has already completed at least one Turn but has no active Turn,
`recoveryPlan()` returns `reconcile_request_outcome`. The final model response
may have occurred before the Request terminal event was persisted, so the SDK
does not retry it automatically. After querying the provider or application
record, use a stable `commandId` to commit `completed`, `failed`, or
`interrupted` explicitly:

```ts
const terminalPending = coordinator.getProjection().activeRequest;
if (!terminalPending?.lastTurnEventId) {
  throw new Error('No terminal-pending Turn');
}

await coordinator.reconcileRequestOutcome({
  commandId: CommandId('reconcile-request-42'),
  requestId: terminalPending.requestId,
  lastTurnEventId: terminalPending.lastTurnEventId,
  outcome: {
    status: 'completed',
    output: 'already completed',
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  },
});
```

`lastTurnEventId` binds the decision to the exact terminal Turn event inspected
by the caller. A newer Turn or a retry with another anchor fails closed.

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
classified as `non_idempotent`. Unfinished tools from a `failed` or `aborted`
Model Attempt are marked `discarded_unconfirmed_model_response` and must not be
retried. A continuation retains at most the latest 16
Model Attempts. Each model response/error and tool input, result, error, and
permission value is limited to 4,000 serialized characters. Oversized values carry
`kind: "truncated_recovery_value"`, the original size, and JSON prefix/suffix
metadata so the model cannot mistake the preview for a complete result.

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
processes can commit it only once. Active-Turn provenance is valid only when
the same command contains the adjacent
`turn_aborted -> request_interrupted -> request_accepted` transition; pre-Turn
provenance additionally requires the preceding synthetic `turn_started`.
`requestId` and `turnId` are preconditions for the state observed by the
caller, so the command cannot silently target a newer active Turn. A
`non_idempotent` tool that is `completed`, `failed`, or `cancelled` after
execution started raises
`DURABLE_RECOVERY_UNSAFE_ROLLOVER` and remains fail-closed; the API does not use
prompting to bypass an unknown side effect.

The current writer uses schema v3, which adds `modelAttemptId` and the complete
model-request lifecycle. In v3, `tool_scheduled.modelAttemptId` explicitly
identifies the Model Attempt that produced the call, `modelInput` preserves the
provider's original arguments, and `input` holds repaired execution input. The
projector uses canonical JSON to match the tool ID, name, and original
arguments to the confirmed model response. If streaming dispatches a tool before
`model_request_completed`, the terminal model event validates all previously
scheduled tools when it arrives. Readers remain compatible with schema-v2 logs
that lack these fields and may append later v3 batches to the same Session. Schema
versions may only increase: a v2 batch after v3 is corrupt, and a v2 batch
cannot masquerade as containing v3 model events. Version 1 logs are not
inferred silently and must be migrated before this runtime can resume them.

### Store deadlines and cooperative cancellation

`SessionOptions.durableStoreTimeoutMs` applies one 15-second deadline by
default to each Journal, subscription, and execution-lease Store call. The SDK
also passes an `AbortSignal` through `append`, `read`, `getHeadSequence`, and
the optional lease methods. Custom Stores should stop waiting and avoid
starting a mutation once that signal aborts.

The SDK host watchdog remains authoritative when a Store ignores cancellation.
An append timeout is treated as an unknown command outcome: the Journal blocks
different commands until the original `commandId` is retried and reconciled.
A lease acquire, heartbeat, assertion, fenced operation, or release timeout
throws `DurableExecutionLeaseTimeoutError`; heartbeat and active fenced
operation timeouts abort `lease.signal` and stop new side effects. Active lease
calls cap the configured timeout to the remaining heartbeat-to-expiry safety
window, and a monotonic local expiry watchdog fails closed even if heartbeat
scheduling is delayed. When Session and lease-specific Store deadlines are both
configured, the stricter value wins.

After an uncertain acquisition timeout, an in-process retry against the same
Store, Session, and owner automatically reuses the generated `leaseId`. The
timeout error also exposes that ID so a retry in another process can pass it
explicitly and reconcile the same acquisition. Retry the same identity with
the same TTL, heartbeat interval, and Store deadline until that uncertainty
window is resolved or expires.

Standalone Journal, subscription, and lease APIs expose `storeTimeoutMs`.
`JsonlDurableEventStore` exposes `operationTimeoutMs`; its default leaves the
configured `lockTimeoutMs` plus 15 seconds for lock-held I/O. Cancellation
removes queued process-local lock waiters and stops cross-process lock polling;
an already-running callback keeps ownership until its cleanup finishes.

### Execution leases and fencing

`DurableExecutionLease` adds opt-in worker ownership on top of Journal CAS:

```ts
const lease = await DurableExecutionLease.acquire(store, sessionId, {
  ownerId: WorkerId('worker-a'),
  ttlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  storeTimeoutMs: 15_000,
});
const journal = await DurableSessionJournal.open(store, sessionId, {
  executionLease: lease,
  storeTimeoutMs: 15_000,
});
```

A lease-capable Store implements `DurableExecutionLeaseStore`. Acquisition,
renewal, release, and `append(..., { executionFence })` must serialize through
the same transactional boundary. A takeover increments `FencingToken`; a stale
writer receives `DURABLE_EXECUTION_LEASE_LOST`, while an unfenced append during
an active lease receives `DURABLE_EXECUTION_LEASE_REQUIRED`. Fencing is sticky:
once a Store creates lease state for a Session, every later append and
Journal/Recovery Coordinator open requires a new active lease even after the
previous lease expires or is released. `requiresExecutionLease()` provides an
early entry-point check; the transactional append check remains authoritative.
Short internal persistence operations can use `withExecutionLease()` to run
under the same ownership lock and avoid racing transcript writes with takeover.
Do not hold this boundary around long-running model or tool I/O.

The process-local lease handle heartbeats automatically. Any renewal or
validation failure aborts `lease.signal` and remains fail-closed. Session
integrates this handle when `SessionOptions.executionLease` is configured:
model calls and tool side effects validate ownership immediately before I/O,
Journal commits carry the fence, and subagent state and output writes run under
the same ownership boundary. Lease loss closes local execution without writing
a false durable terminal event.

The fence protects SDK lifecycle commits. External resources modified by a tool
must also compare `ExecutionContext.executionFence.fencingToken`; otherwise an
already-started operation cannot be forcibly fenced by a generic SDK.
Within the current worker, the SDK terminates a managed shell's complete process
group and waits for it to exit. It is not a cross-process supervisor or a
substitute for downstream token validation.

### Controlled worker handoff

`session.suspendForHandoff()` provides an explicit source-worker barrier before
recovery. It seals new background-subagent admission, cooperatively cancels the
active execution, waits for model/tool settlement and transcript persistence,
closes local runtime resources, and returns the refreshed journal head and
recovery plan.

Unlike `abort()` and `close()`, handoff preserves an unfinished durable
Request/Turn. It does not write `turn_aborted`, `request_interrupted`, or
`session_closed`; any unfinished model or tool boundary is finalized
conservatively before the result is returned. The replacement worker must use
the returned plan with `DurableSessionRecoveryCoordinator` and only call
`resumeSession()` once the plan permits it.

The barrier rejects before cancelling the root Request if any background
subagent or Session-owned background shell remains active. It also requires
both the durable journal and transcript storage. Without `executionLease`,
handoff only coordinates a known source and successor. With it, the source
retains ownership through cleanup and releases the lease before returning, so
the successor can acquire the next token.

## JSONL persistence

Files are stored under:

```text
{storageRoot}/durable-events/{base64url(sessionId)}.jsonl
{storageRoot}/durable-events/{base64url(sessionId)}.lease.json
```

Each line is a complete append batch rather than one event. If the process
stops during a write, recovery ignores the final batch unless it ends with a
newline, so a partial transaction is never accepted.

Each append:

1. queues under the process-wide mutex, then acquires a Session-scoped
   inter-process file lock and rereads and validates the current head;
2. checks the compare-and-append precondition;
3. assigns contiguous sequences and writes one batch;
4. calls file `fsync` before reporting success.

`read()` and `getHeadSequence()` acquire the same lock, so they cannot observe
another process between tail truncation and append. Local mutex queuing and
cross-process acquisition share a total 10-second budget by default. The
complete direct Store call is also bounded by `operationTimeoutMs`; by default
that budget is `lockTimeoutMs + 15000`. An explicit operation timeout must be
at least the lock timeout. The
cross-process lock is an operating-system advisory lock: the kernel releases it
when a process exits or crashes, while a paused live process retains ownership
instead of being displaced after a wall-clock timeout. `lockTimeoutMs: 0`
performs exactly one immediate attempt without queuing or retrying when the lock
is held.

Each event log has a persistent `*.jsonl.lock` sidecar. Its presence does not
mean that the lock is currently held; ownership belongs to an open file
descriptor. Do not delete, replace, or move event logs or their lock sidecars
while any process is using the Store.

The native lock addon is loaded only on the first Store operation, so other SDK
APIs remain importable without it. If the addon cannot load or the platform
does not support advisory locking, the Store fails closed with
`DURABLE_EVENT_LOCK_FAILED`. Prebuilt support currently covers macOS, glibc
Linux, and Windows on x64/arm64. `JsonlDurableEventStore` does not support
Alpine/musl or other targets.

Event files and lease sidecars use mode `0600`. Session IDs are base64url
encoded and cannot become filesystem paths.
Events contain raw request inputs, complete model responses, tool inputs, and
model-facing tool results. Treat the Store as sensitive data and configure
encryption, retention, and access control at the deployment boundary.

## Consistency boundary

`JsonlDurableEventStore` provides mutually exclusive reads, atomic
compare-and-append, and execution leases with monotonic fencing tokens across
Node.js processes on the same host. Lease state and event appends share the
same Session lock. This guarantee requires a local filesystem with working
advisory locks and does not apply to shared network filesystems such as NFS.
Replicated services must implement `DurableExecutionLeaseStore` using database
transactions that atomically validate the fence with each append. An unfenced
timeout-based lease is not sufficient.

`DURABLE_EVENT_WRITE_FAILED` does not prove that a batch was not written. The
outcome can be unknown when `fsync`, unlocking, or closing the lock file fails
after bytes reach the event log. Before retrying, read the head and correlate
events through `commandId` or another domain identifier. The current Store does
not provide automatic command deduplication.

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
| `DurableExecutionLeaseError` | Lease acquisition, heartbeat, ownership, or persisted lease state failed. |
| `DURABLE_EXECUTION_LEASE_CONFLICT` | Another unexpired worker lease owns the Session. |
| `DURABLE_EXECUTION_LEASE_REQUIRED` | An active lease exists but the append did not carry its fence. |
| `DURABLE_EXECUTION_LEASE_LOST` | The lease expired, was released, or was replaced by a higher token. |
| `DURABLE_EXECUTION_LEASE_TIMEOUT` | A lease Store call exceeded its deadline. |
| `SessionDurableRecorderError` | Session runtime observed an invalid durable lifecycle state. |
| `DurableEventProjectionError` | Schema, ordering, or correlation violates lifecycle invariants. |
| `DurableEventSequenceConflictError` | Compare-and-append precondition failed. |
| `DURABLE_EVENT_LOCK_FAILED` | Session file-lock setup or acquisition failed. |
| `DURABLE_EVENT_LOCK_TIMEOUT` | The Session file lock was not acquired within `lockTimeoutMs`. |
| `DURABLE_EVENT_IO_TIMEOUT` | A durable Store append, read, or head lookup exceeded its deadline. |
| `DurableEventStoreError` | Invalid input, cursor, I/O, or log integrity failure. |

A complete newline-terminated record with an invalid schema, duplicate ID, or
non-contiguous sequence is a corrupt log. The Store fails instead of skipping
it.
