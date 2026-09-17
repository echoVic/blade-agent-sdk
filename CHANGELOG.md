# Changelog

All notable changes to `@blade-ai/agent-sdk` are documented here.

## [7.4.12] - 2026-09-15

### Refactoring

- Replace the duplicate transcript event log and replay projector with one atomic `SessionState` projection shared by local and PostgreSQL persistence; legacy transcript event files now fail closed instead of being heuristically repaired.
- Collapse durable recovery onto a v4-only typed event scope, split projection/reduction, recovery payloads, and JSONL lease persistence into focused modules, and make journal projection the sole authority for recorder and recovery state.
- Split Session orchestration into bounded lifecycle, request, durability, state, and stream modules, move SessionRunner ownership to the advanced entrypoint, and define the blade-tool-* package convention.
- Reduce ad hoc type assertions across TypeBox tool compilation, MCP schema adapters, Session tool detection, and built-in memory tools while keeping unavoidable erasure casts at named internal boundaries.
- Clarify Agent runtime type ownership, split the internal execution context into narrow contracts, standardize tool authoring on TypeBox with one schema for inference and runtime validation, and align wire-safe user input and sandbox context schemas.

## [7.4.11] - 2026-09-14

### Features

- Add replayable Agent responses, Session-scoped data Skills, and four canonical package entrypoints.

## [7.4.10] - 2026-09-14

### Features

- Add the layered createAgent API, unified permission configuration, and async Zod tool authoring.

## [7.4.9] - 2026-09-13

### Features

- Read the resume cursor from the message projection's own coverage: the projection records the newest Request whose content it holds, the server maps that Request to its last event, and a gap plus a trimmed log still reports recoveryIncomplete instead of a lossless claim.
- Repair a history gap from the durable journal with an explicit journal-to-message projection: rebuild the user input, the assistant output and tool messages by stable identity, only write data, and leave the gap open when the journal was trimmed.

## [7.4.8] - 2026-09-13

### Features

- Record how far the message projection is complete next to the messages themselves, stop using a resume cursor past a recorded gap, report recoveryIncomplete when a trimmed log cannot be replayed in full, and add repairSessionHistory() to rebuild the missing messages from the durable journal without re-running any model or tool.

### Fixes

- Treat a failed message write as an open history gap that later successful requests cannot clear, and mark the terminal result so a client can tell execution success from a fully saved history.

## [7.4.7] - 2026-09-13

### Features

- Ship the AgentServerStore conformance suite as a public testing helper and run it against both shipped stores, so idempotent appends, command receipts, event sequencing and the retained-range capability cannot differ between implementations.

### Fixes

- Return the required `loaded` flag from the production starter's SessionExecutor.read, and ship a shared read-result contract so the example and host executors are held to the same interface as the SDK's own.
- Keep the in-memory store's idempotent append a synchronous critical section: awaiting the compatibility lookup let two concurrent appends with the same key both pass the check and store two events.
- Restore the session Skill identity after a turn-scoped Skill is cleaned up, so the reported active Skill matches the prompt and patch history that are still applied.
- Stop treating the event head as a resume cursor for stores that cannot report their retained range: the server replays from the start when possible and otherwise reports recoveryIncomplete with no cursor.

## [7.4.6] - 2026-09-13

### Fixes

- Keep session-scoped context overlays through turn cleanup: context contributions are tracked per scope and merged session-then-turn, so a temporary context patch no longer erases the session baseline.
- Read the durable journal tail through the accessor the tenant adapter actually exposes (getHeadSequence), fail loudly when it is missing, and pin the reconciler's test double to the real durable read port so the two cannot drift apart again.
- Deep-copy the event into the in-memory idempotency record, so mutating the caller's object after an append can no longer change what the record returns.
- Recognise idempotency keys written by 7.4.4 and earlier, which stored the key as the event's own id: the legacy shape is read and backfilled into the key table, so upgrading cannot republish a terminal result that the previous version already published.
- Never let the session.read resume cursor skip unscanned output: the search for the last completed request widens over a bounded number of windows and, when it finds none, replays from the start of what the log still retains instead of from the window it happened to read.

## [7.4.5] - 2026-09-13

### Fixes

- Keep idempotency records for the Session's lifetime instead of inside the trimmable event log, so a retry whose original event has been retained away is still recognised as a repeat and does not publish a second time.
- Recover an accepted-but-unenqueued submission from a journal longer than one replay budget by inspecting its tail, where that acceptance is the last durable event, instead of reporting a truncated scan on every startup.
- Stop the session.read resume cursor at the last completed request instead of the event head: the message projection trails the log while a request streams, so a refreshed client could skip output it never received. It now replays the in-flight turn and deduplicates by event id.
- Keep session-scoped tool discoveries through turn cleanup: discovery contributions are tracked per scope and the effective set is re-derived, so a temporary Skill can no longer drop the tools a session patch discovered.

## [7.4.4] - 2026-09-13

### Features

- Make appendEvent idempotent under a caller-supplied key, so a Worker and a reconciler can publish the same terminal result concurrently and the store keeps exactly one event without scanning the log.

### Fixes

- Rebuild an accepted-but-unenqueued submission from the durable journal projection instead of the transcript projection, so a request whose transcript write failed is still recovered.
- Return the event cursor that belongs to the session.read snapshot: it is captured before the snapshot is loaded, so a reconnecting client can replay events (and deduplicate by event id) but can never skip the ones appended while the snapshot loaded.
- Publish the code the tag names: a manual release run checks out the requested tag, verifies HEAD matches it, stamps the version before the build, and refuses to publish a bundle that does not carry the released version.
- Keep session-scoped system-prompt and environment baselines when a turn-scoped Skill replaces them: patch resets now only affect the scope that declared them.
- Close the stream iterator of every failed model attempt before retrying, so a retry no longer leaves the previous provider reader open; cleanup is bounded and the original failure is preserved.

## [7.4.3] - 2026-09-13

### Fixes

- Turn-scoped skill patches without a toolPolicy keep the session policy baseline, so session restrictions survive temporary skill cleanup. Skill registries are cached per full configuration including trustLevel, shellPolicy, and hookPolicy, and background-agent orphan reclaim on shared repositories only touches the owning parent Session's children.
- The session.read recovery snapshot reports the head of the event log, never behind the messages it accompanies, and omits the pending-input count when the Session is not loaded instead of reporting the unknown as zero. The browser SSE parser enforces the 4 MiB frame limit per complete frame and per buffered remainder, measured in UTF-8 bytes.
- Streaming model requests retry failures before the first output, including provider errors the AI SDK reports inside the stream. After output has been delivered the stream terminates with the provider's original error preserved as the cause, including its status code, instead of a generic message.
- Bind queued submission recovery to the original command: a retry with a different input, command, or execution option is rejected instead of silently replacing the pending request, and the acceptance record is written before anything else can fail. Startup reconciliation also rebuilds an acceptance record lost before enqueueing directly from the Session journal.
- Republish recorded terminal results only after the route settles for the same request and attempt with its lease released, so a client can never observe a finished request while the next input would still be refused. Outcomes whose route moved on to another request are superseded instead of published, and both the worker and the startup reconciler check the event log before appending.

### Documentation

- Document the recovery snapshot read boundary, the streaming retry scope, the skill registry cache identity, background-agent ownership on shared repositories, and the production example's submission and terminal-outcome reconciliation contracts.

## [7.4.2] - 2026-09-13

### Refactoring

- Release the version named by the pushed tag: the release workflow now publishes exactly the tagged version (with the same bilingual changelogs), instead of deriving a bump from commit types. Pushing to main no longer releases anything.

## [7.4.1] - 2026-09-12

### Refactoring

- The production example reads its crash-recovery boundary from PostgreSQL route state instead of caching worker notifications in the launcher, so a successor process sees the same committed checkpoint and no recovery state lives outside the store.
- Split tool execution into explicit stages (middleware, hooks, authorization, confirmation, file lock, invocation, result normalization) with a single cleanup guard that owns quarantine and cancellation bookkeeping. Tool behavior, permission decisions, and timeouts are unchanged.

### Documentation

- Document which parts of the production starter the SDK owns — route queue, leases, recovery planning, checkpoints — and which parts are your own repository policy, so the copied modules are adapted rather than re-implemented.

## [7.4.0] - 2026-09-12

### Features

- Return a recovery snapshot from session.read covering route state, pending inputs and the last event sequence, so a reconnecting client no longer depends on its own browser storage to resume.

## [7.3.0] - 2026-09-12

### Features

- Make subagent Session storage an injectable capability so a parent Session on a shared repository can give its subagents the same cross-host recovery, and document that the default file store is host-local.

## [7.2.1] - 2026-09-12

### Refactoring

- Build every tool through one internal assembler so createTool and toolFromDefinition cannot drift apart, keeping their differences to parameter declaration and validation.

## [7.2.0] - 2026-09-12

### Features

- Add ExecutionHost.reclaim() so a successor process can clean up an execution it never provisioned without knowing how the backend names its resources, and use it in the production example instead of a raw container removal.

## [7.1.10] - 2026-09-12

### Refactoring

- Retire the ContextManager paths that no production caller used: a second formatting and compression-cache route, session search, and a tool-result cache that was written on every tool call but never read.

## [7.1.9] - 2026-09-12

### Fixes

- Stop inline Skill commands when the Session is cancelled, and bound SSE frame buffering so a peer that never sends a delimiter cannot grow it without limit.

## [7.1.8] - 2026-09-12

### Fixes

- Probe an MCP server over its transport instead of trusting cached tools, stop the health monitor for real when it is stopped mid-check, and bound the streaming event buffer with lossless text merging.

## [7.1.7] - 2026-09-12

### Fixes

- Make the memory files the authority and rebuild the index from them, so concurrent saves cannot lose entries or make a stored memory invisible, and stop reporting storage failures as a missing memory.

## [7.1.6] - 2026-09-12

### Fixes

- Fail a model stream that reports an error instead of returning partial text as a completed response, and disable the AI SDK's built-in retry so the SDK is the single retry owner.

## [7.1.5] - 2026-09-12

### Fixes

- Discover Skills per project instead of freezing the first caller's configuration, and resolve the Skill list from the working directory the execution runs in.

## [7.1.4] - 2026-09-12

### Fixes

- Scope the sandbox policy to each Session instead of one process-wide singleton, restore the session tool policy when a turn ends, and copy mutable runtime data so later configuration changes cannot alter an existing snapshot.

## [7.1.3] - 2026-09-12

### Fixes

- Abandon sealed commands that never reported a result instead of answering in_progress forever, confirm cancellation only after the execution environment is stopped, and publish SessionRunner terminal results after the route settles.

## [7.1.2] - 2026-09-12

### Fixes

- Separate unknown Session state from an empty conversation in Session reads, and reconcile the production example's accepted-but-unenqueued submissions and unpublished terminal results on launcher startup.

## [7.1.1] - 2026-09-12

### Refactoring

- Derive release versions from the latest v* tag and the conventional commits after it; changelog fragments now only select the changelog section instead of voting on the version.

## [7.1.0] - 2026-09-12

### Features

- Make the first task easier: create-blade-agent defaults to the local starter, defineTool accepts Zod parameters and defaults an omitted sideEffect to non_idempotent, and a new guide covers migrating the production example to your own repository.

## [7.0.6] - 2026-09-12

### Documentation

- Correct runtime documentation against the code: effect error semantics, session fork scopes, four-part approval isolation, required network policy, cursor and finalization details, worker defaults, and the Chinese and English differences.

## [7.0.5] - 2026-09-12

### Documentation

- Describe the production preset as the SDK Session and Docker repository workflow it now runs, document the SessionRunResult finalization contract, and state how changelog fragment types decide the release version.

## [7.0.4] - 2026-09-12

### Fixes

- Modernize the development toolchain: upgrade Vitest to 5, VitePress to its 2.0 preview on Vite 8, and pin patched transitive resolutions so the full dependency audit reports no known vulnerabilities.

## [7.0.3] - 2026-09-12

### Fixes

- Clear the production dependency audit: raise the AI SDK packages and pin patched hono, js-yaml, and qs resolutions, and correct the package manifest so the CLI bin registers on install.
- Stop an uncaught broken-pipe error when a Docker command exits without reading its stdin, and make the repository fixture tests feed stdin without racing the command exit.

## [7.0.2] - 2026-09-12

### Fixes

- Fix repeated answers in Web starters and preserve the current conversation across page refreshes and reconnects, with explicit cancellation feedback.
- Keep SDK Worker stream events correlated to their request, preserve graceful handoffs, and finalize results only after a successful fenced route transition.

### Refactoring

- Run an approved repository editing and testing workflow through durable SDK Sessions, Docker Workers, and browser recovery in the production preset.

## [7.0.1] - 2026-08-28

### Fixes

- Add non-truncatable event quotas and serialize lease, model handoff, worker transition, and approval state changes.
- Strengthen file revision tracking, snapshots, atomic local persistence, CRLF offsets, Unicode truncation, and edit unescaping.
- Harden WebFetch, Hook output, OAuth, remote approvals, tenant identities, shell classification, and MCP tool namespaces against untrusted input.

### Performance

- Bound background output, file tracking, lock waits, scheduler queues, and task persistence work.

## [7.0.0] - 2026-08-28

### Fixes

- Report clear Agent lifecycle errors, release owned resources on destroy, and preserve MCP server source IDs.
- Preserve total Agent turn counts across turn-limit compaction and persist provider-specific non-text user content.
- Remove ModelMessage.metadata and introduce typed ConversationMessage provenance, correlation, telemetry, providerOptions, and extensions fields.
- Enforce canonical filesystem roots, bound compaction inputs, isolate shell environments, conservatively classify Bash commands, and serialize worker lease renewal with route transitions.

## [6.0.5] - 2026-08-26

### Fixes

- Add dependency-minimal local and Web create-blade-agent presets while preserving the production default.

## [6.0.4] - 2026-08-26

### Fixes

- Gate releases on complete failover RTO, throughput, event-loss, and four-point non-idempotent fault metrics with retained CI reports.

## [6.0.3] - 2026-08-26

### Fixes

- Ship create-blade-agent with a five-minute full-stack verification path and an audited generated dependency tree.

## [6.0.2] - 2026-08-26

### Fixes

- Add authenticated runtime health, queue metrics, uncertain-effect reconciliation, and payload-free Worker OpenTelemetry.

## [6.0.1] - 2026-08-26

### Fixes

- Add a one-command Web-to-Docker production stack example with an automated end-to-end smoke check.

## [6.0.0] - 2026-08-26

### Breaking Changes

- Add the production AgentWorker, SessionRunner, EffectDispatcher, and ExecutionHost recovery loop; move PostgreSQL and OpenTelemetry adapters to explicit optional entrypoints.

## [5.4.2] - 2026-08-25

### Refactoring

- Replace overlapping chat, stream, transcript, and tool contracts with domain-owned model types, branded identifiers, explicit persistence ports, and the new browser-safe /model entry point.

## [5.4.1] - 2026-08-25

### Fixes

- Use the PostgreSQL transaction clock for immediately available runtime effects so clock skew cannot delay worker claims.

### Refactoring

- Add the ExecutionHost boundary, a Docker isolation reference host, bounded workspaces and network egress, checkpoints, and one-command ephemeral credential injection.

## [5.4.0] - 2026-08-25

### Refactoring

- Add PostgreSQL-backed worker heartbeats, Session routing and fencing, drain/handoff/preemption, and crash-safe effect recovery.

## [5.3.13] - 2026-08-25

### Refactoring

- Add a PostgreSQL Runtime Store with atomic command, event, effect, and projection commits plus a public conformance suite.

## [5.3.12] - 2026-08-25

### Refactoring

- Extract Session execution behind injectable SessionExecutor and InProcessSessionExecutor contracts.

## [5.3.11] - 2026-08-25

### Refactoring

- Add injectable Session repositories, protocol v1, and the tenant-aware AgentServer and browser AgentClient HTTP/SSE runtime.

## [5.3.10] - 2026-08-25

### Refactoring

- Split runtime defaults into a server facade without implicit host access and a local Node.js facade, replacing the local entry point with node.

## [5.3.9] - 2026-08-25

### Fixes

- Add an instance-scoped Provider Registry for custom model adapters, with fail-closed routing across Sessions, subagents, and compaction.

## [5.3.8] - 2026-08-25

### Fixes

- Persist provider, API adapter, and model provenance for assistant history, and safely downgrade reasoning when replaying across providers or models.

## [5.3.7] - 2026-08-25

### Fixes

- Bound durable Journal, subscription, JSONL, and execution-lease Store calls with cooperative cancellation and typed fail-closed timeouts.

## [5.3.6] - 2026-08-23

### Fixes

- Prevent cancelled file hooks from spawning, contain descendants in owned POSIX process groups or Windows Jobs, and fail closed when cleanup cannot be proven.

## [5.3.5] - 2026-08-23

### Fixes

- Cancel queued tool concurrency and same-file lock waits with the active Request signal without leaking leases or disturbing FIFO order.

## [5.3.4] - 2026-08-23

### Fixes

- Cancel permission and confirmation waits with the active Request signal, and retain Session ownership until uncooperative callbacks finish cleaning up.

## [5.3.3] - 2026-08-23

### Fixes

- Bound Session inline hook events with configurable deadlines, propagate cancellation signals into callbacks, and fail closed while timed-out callbacks remain pending.

## [5.3.2] - 2026-08-23

### Fixes

- Bound tool invocations to 10 minutes by default, expose SessionOptions.toolTimeoutMs, keep the deadline active across progress yields, and fail closed while timed-out cleanup remains pending.

## [5.3.1] - 2026-08-23

### Fixes

- Bound stalled model calls with configurable request and stream-idle timeouts that abort the provider and preserve typed failure semantics.

## [5.3.0] - 2026-08-23

### Features

- Add lease-aware onion model and tool middleware with declarative plugins, durable short-circuit settlement, and subagent propagation.

## [5.2.0] - 2026-08-23

### Features

- Add Store-backed Session execution leases with automatic heartbeats, sticky monotonic fencing, atomic Journal, transcript, and subagent-state guards, process-tree cancellation, and controlled close or handoff release.

## [5.1.1] - 2026-08-23

### Fixes

- Upgrade CI, release, and documentation workflows to Node.js 24-backed GitHub Actions.

## [5.1.0] - 2026-08-23

### Features

- Add a controlled Session worker handoff barrier that seals background-work admission, settles local execution, preserves the unfinished durable frontier, and returns its recovery plan without closing the durable Session.

## [5.0.4] - 2026-08-23

### Fixes

- Make running Session abort and close operations wait for Agent stream cleanup, model and tool settlement, request ownership release, and configured durable Request finalization without consumer deadlocks.

## [5.0.3] - 2026-08-23

### Fixes

- Serialize local Session transcript access across processes, durably sync appends, recover torn crash tails, reject path-unsafe Session IDs, and fail closed on committed record corruption.

## [5.0.2] - 2026-08-23

### Fixes

- Remove unused production packages, upgrade vulnerable dependencies to patched releases, and reject known production vulnerabilities in CI.

## [5.0.1] - 2026-08-23

### Fixes

- Serialize JSONL durable-event reads and compare-and-append writes across Node.js processes with bounded waits and crash-released OS locks.

## [5.0.0] - 2026-08-23

### Breaking Changes

- Persist and deterministically settle model request attempts around provider calls, bind durable tool schedules to authoritative model responses, require explicit reconciliation for unknown outcomes, and advance the durable event wire format to schema v3 with schema-v2 read compatibility.

## [4.4.0] - 2026-08-22

### Features

- Add atomic recovery for Requests that crash before their first Turn, with persist-before-preparation steering, stale-boundary fencing, and explicit Request outcome reconciliation.

## [4.3.0] - 2026-08-22

### Features

- Add atomic active-turn rollover into provenance-linked continuation requests with stale-CAS protection and fail-closed non-idempotent boundaries.

## [4.2.0] - 2026-08-22

### Features

- Add pull-based durable event subscriptions with validated reconnect cursors, replay barriers, bounded buffering, and live delivery.

## [4.1.0] - 2026-08-22

### Features

- Add a durable recovery coordinator with idempotent tool-outcome and permission reconciliation, and automatically resume requests that were accepted before execution started.

## [4.0.0] - 2026-08-22

### Breaking Changes

- Require every tool to declare pure, idempotent, or non-idempotent side-effect semantics; durable event schema v2 persists the final execution input and resolved contract to distinguish replayable work from outcomes that require reconciliation.

### Fixes

- Make changelog fragments drive semantic-release version selection and recognize Conventional Commit bang headers so breaking changes cannot merge without a release.

## [3.3.0] - 2026-08-22

### Breaking Changes

- Integrate fail-closed, opt-in durable event journaling into Session request, turn, tool, permission, abort, close, and stream-cancellation lifecycles; Session.abort() now returns a Promise that settles pending-request durability.

### Features

- Add a command-oriented durable Session journal with lifecycle preflight, bounded CAS retries, idempotent replay, and unknown-write reconciliation.
- Add strict per-event durable lifecycle payloads and deterministic Session recovery projection with explicit tool and permission reconciliation states.
- Add awaited tool lifecycle hooks that enforce durable ordering around scheduling, permission prompts, side-effect start, and terminal result publication.

## [3.2.0] - 2026-08-22

### Features

- Add the first Durable Event Store phase with versioned envelopes, compare-and-append sequencing, cursor reads, and a crash-tolerant JSONL adapter.

## [3.1.2] - 2026-08-22

### Fixes

- Allow Session custom tools to accept complete `Tool` instances from `createTool()` and the Memory tool helpers.

## [3.1.1] - 2026-08-22

### Fixes

- Fail closed when Sandbox is enabled but no supported OS sandbox executor is available.

## [3.1.0] - 2026-08-22

### Features

- Add durable `now`, `next`, and `later` session inputs with safe-point steering and interruptible tool execution.

### Documentation

- Restore generated changelogs and add complete English and Simplified Chinese documentation.

## [3.0.0] - 2026-08-22

### Breaking Changes

- Require every tool `execute` function to return `ToolExecution`.
- Replace the legacy `success`, `llmContent`, and `displayContent` result fields with the structured `status`, `model`, and `display` contract.

### Refactoring

- Add structured streaming tool progress, messages, and effects.
- Centralize tool concurrency limits and split built-in tools into capability groups.
- Initialize file facilities lazily and make local workspace discovery optional.

## [2.0.1] - 2026-08-21

### Fixes

- Guard `send()` against a concurrent `stream()` call with an explicit request phase.

## [2.0.0] - 2026-08-21

### Breaking Changes

- Replace the `SandboxCheckResult` boolean fields with an `outcome` discriminant and require `reason`.

### Performance

- Cache known sessions to avoid scanning every JSONL file on each persistence write.

## [1.1.3] - 2026-08-21

### Fixes

- Preserve tool results when resuming a persisted session.

## [1.1.2] - 2026-08-21

### Fixes

- Clear stale MCP `lastError` state after a successful automatic reconnection.

## [1.1.1] - 2026-08-16

### Fixes

- Preserve abort error classification in the web fetch tool.

## [1.1.0] - 2026-07-02

### Features

- Improve custom tool type inference with the `tools` container and generic `defineTool` data.

### Fixes

- Re-export `JsonObject` and `JsonValue` and correct ESM and tool documentation.
- Declare the GitHub repository used by npm provenance.

## [1.0.12] - 2026-06-01

### Features

- Add browser-safe and server-only package subpath exports.

## [1.0.11] - 2026-06-01

### Features

- Add session token budget configuration.
- Add model parameter configuration and complete tool allowlist handling.
- Add session observability traces.

## [1.0.10] - 2026-05-30

- No user-visible changes.

## [1.0.9] - 2026-05-30

### Features

- Add native DeepSeek provider support, reasoning output handling, and tool-call compatibility.
- Add DeepSeek cache accounting, cost optimization, long-context planning, and batch summaries.

## [1.0.8] - 2026-04-23

### Features

- Add lazy tool loading and typed SDK error classes.

### Refactoring

- Introduce branded identifiers and split tool type definitions.
- Improve lifecycle cleanup and remove unused internal APIs.

## [1.0.7] - 2026-04-18

### Features

- Add concurrency scheduling for tool execution.

### Refactoring

- Rework streaming responses and event queue handling.

## [1.0.6] - 2026-04-17

### Refactoring

- Rework streaming responses and event queue handling.

## [1.0.5] - 2026-04-14

### Refactoring

- Make message arrays readonly and standardize JSON value types.
- Replace `displayContent` with `metadata.summary`.

### Documentation

- Document memory, tool source policies, and subagent collaboration.

## [1.0.4] - 2026-04-12

### Refactoring

- Replace `displayContent` with `metadata.summary`.

### Documentation

- Document memory, tool source policies, and subagent collaboration.

## [1.0.3] - 2026-04-10

### Features

- Introduce `ConversationState` and `ExecutionEpoch` as the message and transaction boundaries.

### Refactoring

- Improve null checking and type safety.

### Documentation

- Refresh documentation for the 1.0 API.

## [1.0.2] - 2026-04-07

### Tests

- Expand integration coverage for persisted sessions, MCP, subagents, and multimodal input.

## [1.0.1] - 2026-04-07

### Features

- Add session recovery and forward the `turn_end` stream event.

## [1.0.0] - 2026-04-07

### Features

- Add runtime tool catalogs, patch-based skill activation, context overflow recovery, token budgets, and background subagents.
- Add opt-in filesystem memory with deterministic ordering.

### Refactoring

- Remove ACP and consolidate agent loop and runtime ownership.

## [0.2.8] - 2026-03-31

### Features

- Persist image content in multimodal session messages.

## [0.2.7] - 2026-03-29

- No user-visible changes.

## [0.2.6] - 2026-03-29

### Refactoring

- Support npm authentication through `.npmrc` in the legacy release script.

## [0.2.5] - 2026-03-29

### Fixes

- Harden the legacy package publishing flow.

## [0.2.4] - 2026-03-29

### Build

- Migrate the repository from Bun to pnpm and Vitest.

### Documentation

- Refresh the README and community links.

## [0.2.3] - 2026-03-27

### Breaking Changes

- Remove the `BYPASSALL` permission mode.

### Documentation

- Launch the VitePress documentation site.

## [0.2.2] - 2026-03-27

### Fixes

- Fix tag pushing in the legacy release script.

### Refactoring

- Replace static-only utility classes.

## [0.2.1] - 2026-03-27

- No user-visible changes.

## [0.2.0] - 2026-03-26

### Features

- Expand hook events and control flow.
- Add inline commands and runtime effects to Skills.
- Allow sessions to disable persistence.

### Breaking Changes

- Remove the built-in skill installer, version checker, default system prompt, and built-in API key management.
- Make storage roots configurable.

## [0.1.19] - 2026-03-20

### Fixes

- Pass the selected registry to Bun publishing.

## [0.1.18] - 2026-03-20

### Features

- Allow sessions to disable persistence.

### Fixes

- Stabilize logger routing across concurrent sessions.

## [0.1.17] - 2026-03-12

### Fixes

- Remove the implicit dependency on `process.cwd()` from filesystem access checks.

## [0.1.16] - 2026-03-12

### Refactoring

- Introduce `ContextSnapshot` for runtime context management.

## [0.1.15] - 2026-03-09

### Features

- Add native OpenAI support and pass through custom headers.

## [0.1.14] - 2026-03-09

### Features

- Improve JSON Schema to Zod conversion.

### Refactoring

- Unify session runtime ownership and remove obsolete plugin, command, spec, and file-checkpoint systems.
- Rework the agent loop, context manager, and logging injection.

## [0.1.13] - 2026-02-28

### Features

- Export the `ProviderConfig` type.

## [0.1.12] - 2026-02-28

### Build

- Add declaration build configuration.

## [0.1.11] - 2026-02-28

### CI

- Pin the public npm registry.

## [0.1.10] - 2026-02-28

### Features

- Add error handling helpers.

### Refactoring

- Standardize on the `AgentEvent` type.

## [0.1.9] - 2026-02-26

### Refactoring

- Make providers lazy, split `Agent`, and isolate MCP registries per instance.

## [0.1.8] - 2026-02-18

### Refactoring

- Extract `AgentLoop`, remove the obsolete execution loop, and standardize event types.

### Tests

- Add focused tests for the agent loop, skill loader, tool registry, and context compressor.

## [0.1.7] - 2026-02-12

### Features

- Export model thinking capability detection utilities.

## [0.1.6] - 2026-02-12

### Features

- Add in-process MCP servers.

### Fixes

- Set MCP server state to `CONNECTED` after successful connect or reconnect.

## [0.1.5] - 2026-02-08

- No user-visible changes.

## [0.1.4] - 2026-02-08

### Features

- Add session forking, sandbox checks, MCP resources, and structured output.
- Add file checkpoint tracking, which was removed in a later release.

## [0.1.3] - 2026-02-08

### Refactoring

- Rework MCP and remove obsolete Copilot and Antigravity services.

## [0.1.2] - 2026-02-08

### Refactoring

- Unify agent events behind a single stream interface.

### Tests

- Add coverage for hooks, token counting, path safety, matching, tool creation, and output parsing.

## [0.1.1] - 2026-02-08

### Features

- Add `SubagentStart` and `TaskCompleted` hook events.

## [0.1.0] - 2026-02-08

- No user-visible changes.

## [0.0.1] - 2026-02-08

- Initial release.
