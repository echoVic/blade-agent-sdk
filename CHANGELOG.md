# Changelog

All notable changes to `@blade-ai/agent-sdk` are documented here.

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
