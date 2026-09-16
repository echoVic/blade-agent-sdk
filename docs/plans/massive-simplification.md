# Massive Simplification Plan

## Objective

Reduce production TypeScript from the 2026-09-16 baseline of **83,805 LOC** to
**58,663 LOC or less** while preserving the supported runtime behavior. The
reduction must come from production source, not tests, generated output, or
documentation.

## Constraints

- Do not use git worktrees.
- Prefer deletion and a smaller state model over moving code between files.
- Remove obsolete compatibility paths instead of retaining dual behavior.
- Keep public boundaries explicit and typed; runtime validation belongs only at
  external data boundaries.
- Break up files over 900 LOC and functions over 150 LOC unless a generated or
  declarative table is demonstrably clearer.
- Commit each completed task separately with a focused conventional commit.
- Every task must pass focused tests, `pnpm lint`, and `pnpm type-check`.
- The final task must pass the full test, docs, changelog, build, entrypoint, and
  LOC gates before publishing a draft PR.

### Task 1: Delete dead and compatibility surfaces [COMPLETED]

Delete unreachable source, deprecated aliases, legacy read/write fallbacks,
duplicate entrypoint facades, and compatibility-only adapters. Remove their
tests and documentation rather than replacing them with wrappers.

Acceptance:

- Delete `ContextFilter` and every other source file unreachable from package
  entrypoints unless a concrete runtime owner is established.
- Remove deprecated `canUseTool`, SessionRunner facade, legacy message envelope,
  legacy task persistence, and compatibility-only MCP/Store methods.
- Remove superseded exports and dependency packages made unused by deletion.
- Production LOC reduction target: at least 2,500 lines.

Result: production TypeScript is **80,755 LOC**, down **3,050 lines** from the
baseline. The context cache/compression stack, dead history repair subsystem,
deprecated permission and package-entrypoint paths, and legacy persistence
migrations were removed.

### Task 2: Collapse the hook subsystem [COMPLETED]

Replace HookManager/HookRuntime/HookExecutor/schema repetition with one typed,
table-driven hook dispatcher and one callback lifecycle implementation.

Acceptance:

- One authoritative event definition table.
- No per-event copy/paste dispatch methods.
- Split remaining files by responsibility; no hook file over 900 LOC.
- Production LOC reduction target: at least 3,500 additional lines.

Result: production TypeScript is **73,999 LOC**, down **6,756 lines** in this
task and **9,806 lines** from baseline. The unreachable shell-hook protocol,
process executor, schema mirror, and 14 uncallable events were removed. Eight
supported inline events now share one `HookDispatcher`; `HookRuntime` contains
only event-specific input/output adaptation and runtime registration.

### Task 3: Simplify durable session events

Unify projection, journal, recovery, recorder, and history-repair state
transitions around shared command/event reducers.

Acceptance:

- Replace repeated correlation, scope, terminal-state, and commit routing with
  shared typed tables/reducers.
- Break up `DurableSessionProjector`, `DurableSessionRecoveryCoordinator`, and
  `SessionDurableRecorder`.
- Remove recovery paths that encode superseded schemas or duplicate journal
  authority.
- Production LOC reduction target: at least 4,500 additional lines.

### Task 4: Consolidate server and PostgreSQL runtimes

Merge repeated SQL transaction, lease, state-transition, payload, and row
mapping code across the two PostgreSQL runtimes and server stores.

Acceptance:

- Shared transaction/savepoint, row decoding, state update, and paging helpers.
- Schema creation expressed as compact migrations rather than giant imperative
  methods.
- No server production file over 900 LOC.
- Production LOC reduction target: at least 5,000 additional lines.

### Task 5: Flatten agent and session orchestration

Replace deeply nested routing in AgentLoop, StreamingToolExecutor,
SessionLifecycle, SessionStreamRunner, and related coordinators with explicit
state transitions and small deciders.

Acceptance:

- No orchestration function over 150 LOC.
- Eliminate repeated cleanup, cancellation, terminalization, and retry routing.
- Make the request/turn/tool ownership flow discoverable from module boundaries.
- Production LOC reduction target: at least 4,000 additional lines.

### Task 6: Consolidate built-in tools

Unify filesystem guards, search execution, web request handling, task CRUD, and
common tool result/error plumbing.

Acceptance:

- Shared filesystem operation core for read/write/edit/notebook.
- Shared search runner for glob/grep and shared web request/result pipeline.
- Declarative task CRUD definitions over one store adapter.
- No built-in tool file over 700 LOC.
- Production LOC reduction target: at least 3,000 additional lines.

### Task 7: Simplify providers, execution hosts, and remaining god files

Collapse provider selection/conversion/retry code and Docker execution helpers,
then address every remaining production file over 900 LOC or function over 150
LOC.

Acceptance:

- One provider routing table and shared message/schema conversion helpers.
- Docker process/provisioning code split into focused modules with shared
  process primitives.
- Remove unused dependencies discovered by the final import graph.
- Production LOC reduction target: enough to reach the global 30% gate.

### Task 8: Final architecture, verification, and PR

Finish documentation and publish the complete simplification.

Acceptance:

- Production TypeScript is **58,663 LOC or less**.
- No production file over 900 LOC without a documented exception.
- No production function over 150 LOC without a documented exception.
- `pnpm lint`
- `pnpm type-check`
- `pnpm test`
- `pnpm docs:build`
- `pnpm changelog:check`
- `pnpm verify:entrypoints`
- `pnpm verify:install`
- Logical commits are pushed on `refactor/massive-simplification`.
- A draft PR targets the repository default branch and reports before/after LOC.
