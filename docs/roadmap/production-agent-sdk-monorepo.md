# Production Agent SDK Monorepo Roadmap

## Goal

Rebuild Blade Agent SDK into a production-grade monorepo inspired by
[`earendil-works/pi`](https://github.com/earendil-works/pi), with three core packages:

- `@blade-ai/ai`: provider-agnostic model API, streaming, usage, pricing, provider options.
- `@blade-ai/agent`: runtime-independent agent kernel, loop contracts, tool calling protocol, state, traces, permissions.
- `@blade-ai/agent-sdk`: session-first product SDK that composes `ai`, `agent`, and local/server adapters.

The public experience remains session-first:

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

Backward compatibility is not a constraint. Architecture correctness, production quality, clear types, and agent-friendly APIs take priority.

Pi reference mapping:

- Pi `@earendil-works/pi-ai` maps to Blade `@blade-ai/ai`.
- Pi `@earendil-works/pi-agent-core` maps to Blade `@blade-ai/agent`.
- Pi `@earendil-works/pi-coding-agent` maps to Blade `@blade-ai/agent-sdk` adapters, but Blade keeps `createSession()` as the primary product API instead of making a CLI-first package the center.
- Pi `@earendil-works/pi-tui` remains an optional future adapter direction, not part of the core SDK split.

## Principles

1. Keep `createSession()` as the primary user-facing API.
2. Make package boundaries enforceable by tests, not convention.
3. Keep `@blade-ai/agent` free of Node-local dependencies, provider implementations, MCP SDK, filesystem, shell, sandbox, and storage implementations.
4. Keep `@blade-ai/ai` focused on model/provider concerns only.
5. Keep local tools, MCP, filesystem, shell, sandbox, and durable stores out of the agent kernel.
6. Develop every feature and bugfix with TDD: failing test, implementation, passing test, docs, commit.
7. Every phase must improve the verification chain before relying on it.
8. Release automation must publish from `main` after CI gates pass.

## Target Architecture

```text
packages/
  ai/
    src/
      index.ts
      model-port.ts
      providers/
      usage/
      pricing/
  agent/
    src/
      index.ts
      kernel/
      protocol/
      ports/
      state/
      tracing/
  agent-sdk/
    src/
      index.ts
      session/
      server/
      local/
      browser/
      tools/
```

Dependency direction:

```text
@blade-ai/agent-sdk -> @blade-ai/agent -> @blade-ai/ai
@blade-ai/agent-sdk -> local/server adapters
@blade-ai/agent     -> no Node-local runtime dependencies
@blade-ai/ai        -> provider SDKs only behind adapter boundaries
```

## Quality Gates

The final production verification chain must include:

- Static gates: `pnpm run lint`, `pnpm run type-check`, package boundary checks.
- Unit tests: provider adapters, agent kernel, session runtime, tool contracts.
- Integration tests: session stream, tool execution, hooks, traces, usage aggregation, compaction.
- Browser-safety tests: `core`/browser-safe entries cannot import Node-only modules.
- Package tests: `pnpm pack`, install tarballs into a temporary consumer, import each package and subpath.
- Build tests: every package emits JS and `.d.ts` with correct exports.
- Release dry-run: semantic-release validates package metadata and provenance.
- Optional live tests: GLM `glm-5.2` via `.env` `baseUrl` and `apiKey`, gated behind an explicit script.

Current guardrails:

- `pnpm run verify:boundaries` scans package source imports and fails if `@blade-ai/ai` depends on agent/session SDK layers, or if `@blade-ai/agent` imports Node-local runtime modules, MCP SDKs, or `@blade-ai/agent-sdk`.
- The same boundary verifier also checks package manifests so `@blade-ai/agent` cannot declare MCP SDKs, provider runtime SDKs, or local filesystem/terminal/storage dependencies.
- `pnpm run test:live:glm` builds `@blade-ai/ai` and verifies one non-streaming plus one streaming request against a GLM/OpenAI-compatible endpoint using `.env` credentials.
- `pnpm run test:live:session-glm` builds all three packages and verifies a real session-first `createSession()` + `send()` + `stream()` turn against the same GLM/OpenAI-compatible endpoint with `allowedTools: []`.

## Roadmap

### Phase 0: Roadmap and Safety Baseline

Objective: Establish the execution contract and prevent accidental regression while the migration begins.

Deliverables:

- This roadmap.
- Baseline tests for package topology expectations.
- Baseline CI/release audit documenting current gaps.

Verification:

- `pnpm run build`
- `pnpm run verify:entrypoints`
- focused package topology tests

Commit:

- `docs: add production monorepo roadmap`

### Phase 1: Workspace Skeleton

Objective: Convert the repo from a single package into a pnpm monorepo without changing runtime behavior.

Deliverables:

- `pnpm-workspace.yaml` with `packages/*`.
- `packages/ai`, `packages/agent`, `packages/agent-sdk`.
- Root scripts that delegate through `pnpm -r`.
- Package-level `package.json`, `tsconfig.json`, `tsup.config.ts`.
- `@blade-ai/agent-sdk` remains the published session-first package.

TDD:

- Add a topology test that fails until all three package manifests exist.
- Add a package export test that fails until each package exposes an `index`.

Verification:

- `pnpm install --lockfile-only`
- `pnpm -r run build`
- `pnpm -r run type-check`
- `pnpm run test`

Commit:

- `build: introduce ai agent agent-sdk workspace skeleton`

Status:

- Implemented workspace skeleton with `packages/ai`, `packages/agent`, and `packages/agent-sdk`.
- Root package is now a private workspace orchestrator.
- `@blade-ai/agent-sdk` is the publishable session-first package and retains the current root, browser, server, session, tools, and local entrypoints during migration.
- Package builds use package-local `tsup.config.ts` plus `tsconfig.build.json` so JS and declaration output are verified independently.
- The publishable `@blade-ai/agent-sdk` build now derives external dependencies from `packages/agent-sdk/package.json`, not the private root orchestrator manifest, keeping package output tied to the package's own publish contract.
- The publishable `@blade-ai/agent-sdk` JS bundle now starts from package-local `packages/agent-sdk/src/*` public entry wrappers instead of direct `../../src/*` tsup entries, creating the first enforceable source-ownership seam before the remaining implementation and declaration output are migrated into the package.
- The browser-safe `@blade-ai/agent-sdk/browser` and `@blade-ai/agent-sdk/core` public source entries now live as explicit package-local contracts instead of wildcard-forwarding to root `src/browser` and `src/core`, while their deeper protocol type modules remain a later package-local migration step.
- The `@blade-ai/agent-sdk/core` JSON, model config, constants, and permission contract types now resolve through package-local `packages/agent-sdk/src/types/*` modules instead of root `src/types/*`, while deeper tool/runtime/session contracts remain staged for later ownership migration.
- The `@blade-ai/agent-sdk/core` tool kind and tool behavior contract now resolve through package-local `packages/agent-sdk/src/tools/types/ToolKind.ts`, while richer tool definition/result/effect contracts remain staged for later package-local migration.
- The `@blade-ai/agent-sdk/core` observability contract types now resolve through package-local `packages/agent-sdk/src/observability/types.ts`; runtime trace recording implementation remains outside browser-safe core.
- The `@blade-ai/agent-sdk/core` runtime contract types now resolve through package-local `packages/agent-sdk/src/runtime/types.ts`; runtime context merging and patch summarization helpers remain outside browser-safe core.
- The `@blade-ai/agent-sdk/core` session stream contract types now resolve through package-local `packages/agent-sdk/src/session/types.ts`; full `SessionOptions` and runtime session management remain outside browser-safe core.
- The `@blade-ai/agent-sdk/core` rich tool contract types now resolve through package-local `packages/agent-sdk/src/tools/types/index.ts`; tool runtime helpers, registries, catalogs, and execution implementations remain outside browser-safe core.

### Phase 2: Extract `@blade-ai/ai`

Objective: Move model/provider responsibilities behind a clean AI package.

Move from current SDK:

- `src/services/ChatServiceInterface.ts`
- `src/services/VercelAIChatService.ts`
- `src/services/RetryPolicy.ts`
- `src/services/deepseek.ts`
- model usage and provider option types that belong to model execution

Deliverables:

- `ModelPort`
- `ModelRequest`
- `ModelStreamEvent`
- `ModelResponse`
- `UsageInfo`
- provider adapters for OpenAI-compatible, OpenAI, Anthropic, Gemini, DeepSeek
- DeepSeek cost helpers in `@blade-ai/ai`

TDD:

- Provider config normalization tests.
- Stream event conversion tests.
- Usage aggregation tests.
- DeepSeek pricing/caching tests.
- No agent/session import allowed from `@blade-ai/ai`.

Live verification:

- Add `pnpm run test:live:glm` that reads `.env`, uses `glm-5.2`, and performs:
  - one non-streaming response
  - one streaming response
  - usage assertion when provider returns usage

Commit:

- `refactor(ai): extract provider runtime package`

Status:

- First extraction increment complete: retry policy now lives in `@blade-ai/ai/retry`.
- The legacy root path `src/services/RetryPolicy.ts` re-exports the package implementation so existing runtime code keeps working during migration.
- `@blade-ai/ai` now publishes a `./retry` subpath with JS and declaration output.
- Chat protocol types now live in `@blade-ai/ai/chat`, including `ChatConfig`, `Message`, `UsageInfo`, `StreamChunk`, `ChatResponse`, and `IChatService`.
- The legacy root `src/services/ChatServiceInterface.ts` now re-exports chat protocol types and keeps only the SDK-local `createChatServiceAsync()` factory.
- Model execution protocol types now live in `@blade-ai/ai/model`, including `ModelPort`, `ModelRequest`, `ModelStreamEvent`, `ModelResponse`, `ModelToolCall`, and model-scoped `UsageInfo`.
- The `@blade-ai/ai` root exports `Model*` protocol types and `ModelUsageInfo` while preserving the existing chat `UsageInfo` root export until the chat/runtime migration is complete.
- The first provider runtime adapter now lives in `@blade-ai/ai/providers/openai-compatible`, exposing a `ModelPort` over Vercel AI SDK's OpenAI-compatible provider and normalizing text, reasoning, tool calls, usage, and stream events.
- The GLM live test now supports both JSON `.env` files with `key/url` fields and conventional `GLM_API_KEY`/`GLM_BASE_URL` environment variables, normalizing gateway root URLs to `/v1`.
- The session SDK's `VercelAIChatService` now delegates `provider: "openai-compatible"` chat and stream execution through `@blade-ai/ai/providers/openai-compatible`, beginning the recomposition of SDK runtime code on top of `@blade-ai/ai`.
- Vercel AI provider construction now lives in `@blade-ai/ai/providers/vercel`, covering native OpenAI, Anthropic, Gemini, Azure OpenAI, DeepSeek, and custom OpenAI-compatible model factories; the session SDK consumes this factory instead of directly constructing provider SDK models.
- DeepSeek pure provider helpers now live in `@blade-ai/ai/deepseek`, including model normalization, endpoint selection, cache-aware usage and pricing helpers, cache-prefix optimization, long-context chunk planning, strict tool schema sanitization, and default DeepSeek model config.
- DeepSeek runtime fetch APIs now live in `@blade-ai/ai/deepseek`, including FIM completion, chat completion, batch chat completion, per-response usage parsing, cache optimization, and cost calculation; the legacy SDK `src/services/deepseek.ts` path re-exports these runtime functions during migration.
- A package boundary verifier now enforces key Pi-style dependency direction checks during the migration, including rejecting provider SDK dependencies from the session SDK package manifest.
- Generic Vercel AI execution now lives in `@blade-ai/ai/providers/vercel` as `createVercelModelPort`, covering generate and stream execution for native OpenAI, Anthropic, Gemini, Azure OpenAI, DeepSeek, and compatible fallback providers.
- `ModelRequest` now carries structured output format, assistant tool-call context, tool results, strict tool metadata, and provider options so model adapters own provider-runtime message/tool/output conversion.
- The OpenAI-compatible and generic Vercel ModelPort adapters now normalize structured output, assistant tool calls, tool results, usage, reasoning, stream events, and DeepSeek strict-tool/thinking options behind `@blade-ai/ai`.
- The session SDK's `VercelAIChatService` now delegates all provider chat and stream execution through `ModelPort`, with no direct `generateText`, `streamText`, `jsonSchema`, or `Output` runtime dependency in the session service.

### Phase 3: Extract `@blade-ai/agent`

Objective: Create a runtime-independent agent kernel with clear ports and protocol types.

Move or define:

- agent stream protocol
- tool call protocol
- turn state
- usage aggregation
- trace events
- permission decision contracts
- `AgentKernel`
- ports:
  - `ModelPort`
  - `ToolPort`
  - `PermissionPort`
  - `StorePort`
  - `HookPort`
  - `TracePort`

Must not include:

- `node:*`
- MCP SDK
- builtin local tools
- provider SDK implementations
- filesystem storage implementations
- shell/sandbox

TDD:

- Agent kernel no-tool turn test.
- Agent kernel tool-call turn test.
- Permission deny/allow tests.
- Abort handling test.
- Trace event emission test.
- Package boundary test forbidding Node-local imports.

Commit:

- `refactor(agent): extract runtime-independent agent kernel`

Status:

- First kernel increment complete: `@blade-ai/agent` now exposes a runtime-independent `AgentKernel.runTurn()` that executes a no-tool user turn through `@blade-ai/ai`'s `ModelPort` and emits content, usage, thinking, and result events.
- The first Phase 3 TDD guardrail lives in `packages/agent/src/__tests__/AgentKernel.test.ts`, proving the kernel can run without Node-local, MCP, provider SDK, filesystem, shell, sandbox, or session SDK dependencies.
- The second kernel increment adds the first tool-call turn loop: `AgentKernel` can execute `ModelResponse.toolCalls` through an injected `AgentToolPort`, emit `tool_use` and `tool_result` events, append assistant/tool messages, and perform a follow-up model call for the final answer.
- The third kernel increment adds `AgentPermissionPort` with allow/deny decisions before tool execution; denied tool calls do not reach `AgentToolPort`, emit an error tool result, and are fed back into the follow-up model call.
- The fourth kernel increment adds a minimal runtime-independent `AgentTracePort`, with TDD coverage proving that turn start, model request/response, tool call start/end, usage, and turn end activity can be recorded as structured trace events without changing the session-first stream API.
- The fifth kernel increment adds the first abort guard: if a turn starts with an already-aborted `AbortSignal`, `AgentKernel` emits a controlled `ABORTED` error event and does not call the model port.
- The sixth kernel increment adds multi-iteration tool loops with a `maxSteps` model-step limit, so the kernel can continue across repeated model tool-call responses while stopping runaway loops with a controlled `MAX_STEPS_EXCEEDED` error event.
- The seventh kernel increment adds a runtime-independent `AgentStorePort`, allowing the kernel to append newly created input, assistant, and tool messages with turn/step context while leaving filesystem, database, and session storage implementations to outer adapters.
- The eighth kernel increment adds a runtime-independent `AgentHookPort` for model lifecycle hooks: `beforeModel` can rewrite model requests, and `afterModel` can observe responses with turn, step, and message context, preparing the session hook runtime migration without coupling the kernel to SDK-local hooks.
- The ninth kernel increment splits `@blade-ai/agent` source ownership into package-local `kernel`, `protocol`, `ports`, `state`, and `tracing` modules while keeping the root package export stable. `AgentKernel` now lives in `src/kernel/AgentKernel.ts`, and protocol/port/state/trace contracts are independently importable within the package for future kernel growth.
- The tenth kernel increment publishes the kernel package modules as explicit subpath exports: `@blade-ai/agent/kernel`, `@blade-ai/agent/protocol`, `@blade-ai/agent/ports`, `@blade-ai/agent/state`, and `@blade-ai/agent/tracing`. Package verification now requires those JS/declaration files in the tarball and imports each subpath from a temporary consumer install.
- The eleventh kernel increment adds optional model-level streaming mode: `AgentKernel` can call `ModelPort.stream()`, emit incremental thinking/content/usage events, aggregate the streamed response, and continue through the same tool loop, trace, hook, and store path without depending on provider or runtime adapters.

### Phase 4: Rebuild `@blade-ai/agent-sdk`

Objective: Recompose the session-first SDK on top of `@blade-ai/ai` and `@blade-ai/agent`.

Deliverables:

- `createSession()`
- `resumeSession()`
- `forkSession()`
- `prompt()`
- server/local adapters:
  - local tool registry
  - MCP registry
  - filesystem/session store
  - sandbox
  - hooks runtime
- browser-safe entry and server-only stubs remain.

TDD:

- Existing session tests migrated to `packages/agent-sdk`.
- `allowedTools: []` disables all tools.
- sampling options flow into model config.
- tokenBudget flows into runtime.
- observability trace remains intact.

Commit:

- `refactor(agent-sdk): recompose session-first sdk on core packages`

Status:

- First adapter increment complete: `SessionKernelAdapter` bridges the existing session tool registry and execution pipeline into `AgentToolPort`, and `SessionRuntime.getKernelToolPort()` exposes registered local/MCP/custom tools to `AgentKernel` without coupling `@blade-ai/agent` to SDK-local session internals.
- Second adapter increment complete: `SessionKernelStoreAdapter` bridges `AgentStorePort` into the existing session `ContextManager`, preserving kernel-appended user, assistant, and tool messages in session-first history with kernel turn/step metadata.
- Third adapter increment complete: `SessionKernelTraceAdapter` bridges `AgentTracePort` into the existing session `TraceRecorder`, preserving kernel turn/model/tool/usage events under the session observability redaction and payload-capture policy.
- Fourth adapter increment complete: `SessionRuntime.createAgentKernel()` composes an `AgentKernel` from an injected `ModelPort` plus the session store, trace, and optional tool adapters, creating the first runtime-level seam for replacing the legacy session loop with the runtime-independent kernel.
- Fifth adapter increment complete: `AgentKernel` now accepts runtime-independent model request defaults, and `SessionRuntime.createAgentKernel()` can build its own `ModelPort` plus request defaults from the session `BladeConfig`, preserving provider, model, sampling, context, provider options, and thinking capability while keeping the kernel free of provider implementations.
- Sixth adapter increment complete: `SessionRuntime.streamAgentKernelTurn()` added a guarded kernel stream path that maps kernel content, thinking, tool, usage, error, and result events into the existing session `StreamMessage` protocol, creating the path that later became the public default.
- Seventh adapter increment complete: `SessionKernelHookAdapter` bridges the kernel `AgentHookPort` into the session `HookRuntime` for first-step prompt submission rewrites, so guarded kernel turns preserve session-first prompt hooks before `Session.stream()` is moved onto the kernel loop.
- Eighth adapter increment complete: `Session.stream({ experimentalKernel: true })` exposed the first session-first public switch onto the kernel stream path, preserving pending-message consumption, abort signal composition, trace finishing, task-completed hooks, tool execution context, and `session.messages` synchronization before the kernel runtime became the default.
- Ninth adapter increment complete: the kernel tool port now lists real model tool definitions instead of placeholder call shapes, and `AgentKernel` includes registered session tool schemas in model requests so the experimental session-first kernel path can advertise local/MCP/custom tools before executing tool calls.
- Tenth adapter increment complete: the kernel stream path now round-trips tool calls through session tools, feeds tool results back into the follow-up model request, emits session `tool_use`/`tool_result` events, and preserves assistant `tool_calls` plus tool `name`/`tool_call_id` when synchronizing `session.messages`.
- Eleventh adapter increment complete: the kernel stream path now preserves the pending user message when a turn is aborted before model execution, emits a controlled `ABORTED` stream error without calling the model, and finishes observability traces with `aborted` status.
- Twelfth adapter increment complete: kernel observability now records usage with the same session max context token limit used by stream `usage` events, keeping trace-based debugging and accounting aligned with the session-first public API.
- Thirteenth adapter increment complete: kernel tool results now preserve permission update effects, emit session `tool_permission_updates` events before `tool_result`, and record the same updates into the session trace so permission state remains observable through the kernel path.
- Fourteenth adapter increment complete: `Session.stream()` now uses the runtime-independent kernel path by default, while `stream({ runtime: 'legacy' })` remains as an explicit migration escape hatch for old loop behavior; the deprecated `experimentalKernel` flag is still accepted during the transition.
- Fifteenth adapter increment complete: the `@blade-ai/agent-sdk` package build now resolves every public JS entry (`.`, `browser`, `server`, `session`, `tools`, `local`, and `core`) through package-local source wrappers, with a topology test preventing the package tsup config from pointing directly at root `../../src/*` entry files. This is an incremental package-ownership step; the wrapped implementations and declaration emit still need to move package-local in later slices.
- Sixteenth adapter increment complete: the browser-safe `browser/index`, `browser/server-only-stub`, and `core/index` public source entries are now owned inside `packages/agent-sdk/src`, with a topology guard preventing them from regressing to root wildcard forwarders. These entries still reference deeper root protocol/type modules until those modules are migrated package-local in later slices.
- Seventeenth adapter increment complete: `@blade-ai/agent-sdk/core` now owns its JSON value/object types, model and sandbox config contracts, constants, and permission request/result/update type contracts in package-local `src/types/*` files. Runtime permission handler factories remain in the root SDK implementation for now because they depend on non-contract validation/runtime code.
- Eighteenth adapter increment complete: `@blade-ai/agent-sdk/core` now owns `ToolKind` and `ToolBehavior` in package-local `src/tools/types/ToolKind.ts`, and the package-local permission contracts use that local tool kind type. `ToolDefinition`, `ToolConfig`, `ToolResult`, and `ToolEffect` still come from root tool contracts until their dependent runtime/session types are migrated.
- Nineteenth adapter increment complete: `@blade-ai/agent-sdk/core` now owns `AgentTrace`, `TraceEvent`, `TraceSpan`, `TraceSink`, and `ObservabilityOptions` as package-local observability contracts. `TraceRecorder` stays in the server/session implementation because it is runtime behavior, not a browser-safe contract.
- Twentieth adapter increment complete: `@blade-ai/agent-sdk/core` now owns `RuntimeContext`, `ContextSnapshot`, `RuntimePatch`, `RuntimeContextPatch`, and related runtime patch contract types in package-local `src/runtime/types.ts`. Root runtime helper functions such as `mergeContext`, `createContextSnapshot`, and `summarizeRuntimePatchApplications` stay in the implementation layer.
- Twenty-first adapter increment complete: `@blade-ai/agent-sdk/core` now owns `SendOptions`, `StreamOptions`, `StreamMessage`, and the message payload contracts needed by stream events in package-local `src/session/types.ts`. Broader session construction, MCP, persistence, hooks, and adapter runtime options stay in the session implementation layer.
- Twenty-second adapter increment complete: `@blade-ai/agent-sdk/core` now owns `ExecutionContext`, `ToolDefinition`, `ToolConfig`, `ToolResult`, `ToolEffect`, and related tool authoring contracts in package-local `src/tools/types/index.ts`. Root-side tool helper functions, validation adapters, registries, catalogs, background managers, and concrete tool execution remain implementation-layer concerns.
- Twenty-third adapter increment complete: `@blade-ai/agent-sdk/session` now has a package-local public source entry and package-local declaration overlay that export local session-first contracts (`SessionOptions`, `ISession`, resume/fork/prompt options, user message content, MCP/session status, token budget, hooks, and logger shapes) while wrapping the existing root session runtime. The package build now emits `dist/session/index.d.ts` from `packages/agent-sdk/src/session/index.ts` instead of the legacy root `src/session/index.ts`.
- Twenty-fourth adapter increment complete: `@blade-ai/agent-sdk/tools` now has a package-local public source entry and package-local declaration overlay that export local tool authoring contracts (`Tool`, `ToolConfig`, `ToolDefinition`, `ToolCatalog*`, `ToolKind`, `ToolErrorType`, and helper signatures) while wrapping the existing root tool factory and catalog runtime. The package build now emits `dist/tools/index.d.ts` from `packages/agent-sdk/src/tools/public-index.ts` instead of the legacy root `src/tools/index.ts`.
- Twenty-fifth adapter increment complete: the Node adapter public entries `@blade-ai/agent-sdk/server` and `@blade-ai/agent-sdk/local` now have package-local source ownership instead of wildcard-forwarding to root `src/server` / `src/local`. `server` is a package-local session-first facade over the package root, while `local` explicitly exposes MCP, memory, sandbox, builtin-tool, and memory-tool adapter modules from the implementation layer.
- Twenty-sixth adapter increment complete: the root `@blade-ai/agent-sdk` public entry now has package-local session-first source ownership instead of wildcard-forwarding to legacy root `src/index.ts`. Its public declaration overlay is emitted from package-local facade declarations, points only at final public subpath entries (`core`, `local`, `session`, and `tools`), and keeps `createSession()` as the root API while preserving compatibility exports for DeepSeek helpers, permission handlers, local adapters, subagents, and tool authoring contracts.
- Twenty-seventh adapter increment complete: `@blade-ai/agent-sdk/core` now owns the runtime permission handler factories (`createPermissionHandlerFromCanUseTool`, mode/rule/path-safety/composite handlers) in package-local `src/types/permissions.ts`, so root and core entries no longer import those factories from legacy root `src/types/permissions.ts`. The package-local path-safety handler keeps lightweight dangerous-path and sensitive-credential checks without pulling the legacy `SensitiveFileDetector` runtime into the core entry.
- Twenty-eighth adapter increment complete: `@blade-ai/agent-sdk/tools` now owns the public tool authoring runtime (`createTool`, `defineTool`, `toolFromDefinition`, `ToolCatalog`, invocation validation, zod-to-json-schema conversion, catalog source metadata, MCP removal, and simple search) inside package-local `src/tools/index.ts`. The tools entry no longer imports legacy root `src/tools/core/createTool.ts` or `src/tools/catalog/ToolCatalog.ts`; heavier builtin/local tool execution remains in the local adapter layer for later slices.
- Twenty-ninth adapter increment complete: the root `@blade-ai/agent-sdk` entry now owns subagent compatibility exports through package-local `src/subagents/*` instead of re-exporting legacy root `src/agent/subagents/*`. The package-local registry preserves builtin/session registration, directory loading, Claude-style permission mode mapping, source grouping, and plugin cleanup; `SubagentExecutor` is now a runner-injectable compatibility facade so the root entry no longer drags the legacy Agent runtime through the subagent export path.
- Thirtieth adapter increment complete: `@blade-ai/agent-sdk/session` now owns the session-first API control flow through a package-local `SessionRuntimeFactory` seam. `createSession`, `resumeSession`, `forkSession`, and `prompt` route through the local factory, `resumeSession`/`forkSession` enforce persistence guards in the package entry, and tests can inject a factory with `setSessionRuntimeFactory()` while the default factory temporarily adapts the legacy root session runtime until the full session implementation is migrated.
- Thirty-first adapter increment complete: `@blade-ai/agent-sdk/local` now owns its Node-local public runtime aggregation through package-local adapter seams (`mcp`, `memory`, `sandbox`, and `builtin-tools`). The `local/index.ts` entry no longer imports legacy root modules directly; it re-exports from package-local adapter files so MCP, filesystem memory, sandbox, builtin tools, and memory tools can be migrated independently without changing the public `local` entry shape.
- Thirty-second adapter increment complete: `@blade-ai/agent-sdk/local` now owns the filesystem memory runtime locally. `MemoryType`, `MemoryInput`, `Memory`, `MemoryStore`, `FileSystemMemoryStore`, and `MemoryManager` live in package-local `src/local/memory.ts`, preserving slug validation, `MEMORY.md` index maintenance, deterministic listing/search, and index rendering without importing legacy root `src/memory`.
- Thirty-third adapter increment complete: `@blade-ai/agent-sdk/local` now owns the memory read/write tools locally. `createMemoryReadTool()` and `createMemoryWriteTool()` use the package-local tool authoring runtime plus package-local `MemoryManager`; broader file/shell/search/task/todo/web/plan/system builtin suites remain staged for later package-local migration.
- Thirty-fourth adapter increment complete: `@blade-ai/agent-sdk/local` now owns the sandbox runtime locally. `SandboxExecutor`, `SandboxService`, their singleton helpers, command checks, sandbox capability detection, execution option building, and command wrapping live in package-local `src/local/sandbox.ts` without importing legacy root `src/sandbox`.
- Thirty-fifth adapter increment complete: `@blade-ai/agent-sdk/local` now owns the in-process MCP facade locally. `tool()` and `createSdkMcpServer()` live in package-local `src/local/mcp.ts`, use the MCP SDK directly, and no longer import legacy root `src/mcp` for local MCP server construction.
- Thirty-sixth adapter increment complete: `@blade-ai/agent-sdk/local` now owns the builtin tools entry locally. `getBuiltinTools()` no longer re-exports legacy root builtin registration; its current package-local baseline returns no tools by default and registers package-local memory read/write tools when a `MemoryManager` is provided, while the broader builtin suites remain staged for later adapter migrations.
- Thirty-seventh adapter increment complete: `@blade-ai/agent-sdk/session` now owns the JSONL session store implementation locally. `JsonlSessionStore`, `NoopSessionStore`, session snapshots, summaries, timelines, tool-call state, and subagent refs can be rebuilt from the existing unified JSONL event format without importing legacy root `src/session/SessionStore` or root context storage helpers, preparing the package-local `Session` runtime migration.
- Thirty-eighth adapter increment complete: `@blade-ai/agent-sdk/session` now owns session model/runtime config construction locally. `buildSessionModelConfig()` and `buildBladeConfig()` convert public `SessionOptions` into package-local `ModelConfig`/`BladeConfig`, preserving provider mapping, OpenAI organization/project headers, default base URLs, sampling, max output/context tokens, provider options, and thinking options without calling legacy root `Session` private helpers.
- Thirty-ninth adapter increment complete: `@blade-ai/agent-sdk/session` now has a package-local `src/session/Session.ts` lifecycle entry for `createSession`, `resumeSession`, `forkSession`, and `prompt`. The default `SessionRuntimeFactory` depends on this package-local entry instead of importing legacy root `src/session/Session` directly, leaving the legacy root session runtime isolated behind a single temporary adapter while the package-local `Session` implementation is migrated incrementally.
- Fortieth adapter increment complete: `@blade-ai/agent-sdk/session` now owns the public `prompt()` lifecycle locally. The package-local lifecycle creates a session through the injected factory, sends the user message, consumes stream events into `PromptResult` tool calls, usage, duration, and turn count, and closes the session in a `finally` block; the legacy adapter no longer imports the root `prompt()` helper.
- Forty-first adapter increment complete: `@blade-ai/agent-sdk/session` now owns the public `forkSession()` lifecycle locally. The package-local lifecycle resumes the source session through the injected factory, calls the live session's `fork({ messageId })`, and closes the source session in a `finally` block; the legacy adapter no longer imports the root `forkSession()` helper.
- Forty-second adapter increment complete: the public `@blade-ai/agent-sdk/session` entry now routes all four session-first API functions (`createSession`, `resumeSession`, `forkSession`, and `prompt`) through package-local lifecycle functions in `src/session/Session.ts`. `createSession()` and `resumeSession()` remain thin wrappers over the injected runtime primitive for now, but the public entry no longer bypasses the package-local lifecycle boundary.
- Forty-third adapter increment complete: `@blade-ai/agent-sdk/session` now owns the `persistSession: false` resume/fork guards inside the package-local lifecycle facade instead of the public entry wrapper. The public session entry now only injects the configured runtime factory into `createSession`, `resumeSession`, `forkSession`, and `prompt`, while lifecycle invariants live with the package-local session control flow.
- Forty-fourth adapter increment complete: `SessionRuntimeFactory` is now a narrow primitive port with only `create()` and `resume()`. Package-local lifecycle code owns `forkSession()` and `prompt()` composition, and both the default runtime factory and the legacy root adapter no longer expose `fork()` or `prompt()` escape hatches that could bypass the session lifecycle facade.
- Forty-fifth adapter increment complete: the default `@blade-ai/agent-sdk/session` runtime factory now lazy-loads the temporary legacy root session adapter on first `create()`/`resume()` use instead of statically importing it. This keeps the public session entry on package-local lifecycle code during module load and narrows the remaining root implementation dependency to a deferred server-runtime boundary.
- Forty-sixth adapter increment complete: the temporary legacy root session adapter remains behind a lazy boundary, and package verification now inspects the packed public `dist/session/index.js` static import closure to ensure legacy root session runtime content is not eagerly bundled into the session entry. Dynamic loading of the temporary adapter remains allowed until the package-local `Session` runtime fully replaces it.

### Phase 5: Production Verification Chain

Objective: Make quality gates broad enough for a production agent SDK.

Deliverables:

- `pnpm run verify`
- `pnpm run verify:packages`
- `pnpm run verify:entrypoints`
- `pnpm run test:unit`
- `pnpm run test:integration`
- `pnpm run test:live:glm`
- temporary consumer install test from packed tarballs
- package boundary scanner
- browser bundle scanner
- documentation build gate

CI:

- CI runs lint, type-check, build, unit, integration, package verification, docs build.
- Live GLM tests stay manual or scheduled with secrets, not mandatory for every PR.

Status:

- First verification-chain increment complete: root `pnpm run verify` now aggregates lint, root and workspace type checks, package boundary checks, docs build, entrypoint/browser-safety checks, packed package smoke tests, unit tests, and integration tests. `pnpm run verify:packages` packs `@blade-ai/ai`, `@blade-ai/agent`, and `@blade-ai/agent-sdk`, checks required JS/declaration files and absence of test files, installs the tarballs into an external temporary consumer, and imports the public package/subpath exports. The release workflow now runs the same `pnpm run verify` gate before semantic-release.
- Second verification-chain increment complete: the package boundary verifier now rejects forbidden runtime dependencies declared in the `@blade-ai/agent` manifest, not just forbidden imports from source files, protecting the runtime-independent kernel boundary before code is imported.
- Third verification-chain increment complete: `pnpm run test:live:session-glm` now provides a dedicated session-first live smoke over the built `@blade-ai/ai`, `@blade-ai/agent`, and `@blade-ai/agent-sdk` packages, while the heavier `test:integration` suite remains explicitly gated by `INTEGRATION_API_KEY` / `INTEGRATION_BASE_URL`.
- Fourth verification-chain increment complete: `pnpm run verify:packages` now inspects packed declaration file contents for critical ownership regressions, currently preventing `@blade-ai/agent-sdk/session` from publishing a `dist/session/index.d.ts` that points back at the legacy root `./Session.js` declarations.
- Fifth verification-chain increment complete: `pnpm run verify:packages` now fresh-builds `@blade-ai/ai`, `@blade-ai/agent`, and `@blade-ai/agent-sdk` before packing, and it rejects `@blade-ai/agent-sdk/tools` declaration regressions that point back at legacy root `./core/createTool.js` or `./catalog/index.js` declarations.
- Sixth verification-chain increment complete: `pnpm run verify:packages` now rejects root `@blade-ai/agent-sdk` declaration overlays that leak temporary `public-index.js` references or legacy root implementation declarations, and it rejects `@blade-ai/agent-sdk/local` declaration regressions that point back at root MCP, memory, sandbox, or builtin-tool declaration modules.
- Seventh verification-chain increment complete: `pnpm run verify:packages` now requires the packed `@blade-ai/agent-sdk` permission declarations, rejects public declaration maps for overlaid root/core/local/session/tools/permission entries, and prevents permission declarations from regressing to legacy `SensitiveFileDetector` or `ToolEffects` dependencies.
- Eighth verification-chain increment complete: `pnpm run verify:packages` now rejects packed `@blade-ai/agent-sdk/tools` runtime and declaration regressions that point back at legacy root `src/tools/core/createTool` or `src/tools/catalog/ToolCatalog`, keeping the public tool authoring entry package-local.
- Ninth verification-chain increment complete: `pnpm run verify:packages` now rejects packed root `@blade-ai/agent-sdk` runtime and declaration regressions that point back at legacy root `src/agent/subagents`, keeping root subagent compatibility exports package-local.
- Tenth verification-chain increment complete: `pnpm run verify:packages` now requires the packed `@blade-ai/agent-sdk/session` runtime factory declaration and rejects `dist/session/index.js` regressions that directly point back at legacy root `src/session/Session`, keeping the public session entry on the package-local factory seam.
- Eleventh verification-chain increment complete: `pnpm run verify:packages` now rejects packed `@blade-ai/agent-sdk/local` entry regressions where `dist/local/index.js` directly points back at legacy root `src/mcp`, `src/memory`, `src/sandbox`, or `src/tools/builtin`, while topology tests require package-local MCP, memory, sandbox, and builtin-tool adapter source files.
- Twelfth verification-chain increment complete: `pnpm run verify:packages` now rejects packed `@blade-ai/agent-sdk/local` memory declaration regressions that publish the earlier stub-style `read`/`write`/boolean-delete API instead of the package-local `save`/`get`/`list`/`delete` memory API.
- Thirteenth verification-chain increment complete: topology tests now require package-local memory tool sources and reject legacy root memory-tool imports from `local/builtin-tools.ts`; package verification also rejects packed `@blade-ai/agent-sdk/local` runtime regressions that point directly at legacy root memory tools.
- Fourteenth verification-chain increment complete: topology tests now reject legacy root sandbox imports from `local/sandbox.ts`, and package verification rejects packed local sandbox declarations that fall back to the old placeholder constructor-only shape.
- Fifteenth verification-chain increment complete: topology tests now reject legacy root MCP imports from `local/mcp.ts`, and package verification rejects packed local MCP declarations that fall back to the old `unknown[]` placeholder signatures.
- Sixteenth verification-chain increment complete: topology tests now reject legacy root builtin-tool imports from `local/builtin-tools.ts`, and package verification rejects packed local builtin declarations that fall back to the old `getBuiltinTools(...args: unknown[])` placeholder signature.
- Seventeenth verification-chain increment complete: topology tests now require package-local session store source ownership, and package verification requires the packed `@blade-ai/agent-sdk` session store declaration while rejecting declaration regressions that point back at root context storage or legacy root `SessionStore`.
- Eighteenth verification-chain increment complete: topology tests now require package-local session config source ownership, and package verification requires the packed `@blade-ai/agent-sdk` session config declaration while rejecting declaration regressions that point back at legacy root `Session` or non-package-local config types.
- Nineteenth verification-chain increment complete: topology tests now require `packages/agent-sdk/src/session/Session.ts` and reject default factory imports that bypass it. Package verification also requires the packed `dist/session/Session.d.ts` declaration and rejects declarations that expose legacy root `src/session/Session` contracts.
- Twentieth verification-chain increment complete: session factory tests now prove package-local `prompt()` is composed from `create`/`send`/`stream`/`close` instead of delegating to `SessionRuntimeFactory.prompt()`, and topology tests reject reintroducing the root `prompt` import in the legacy session adapter.
- Twenty-first verification-chain increment complete: session factory tests now prove package-local `forkSession()` is composed from `resume` plus the live session's `fork()` and source-session cleanup instead of delegating to `SessionRuntimeFactory.fork()`, and topology tests reject reintroducing the root `forkSession` import in the legacy session adapter.
- Twenty-second verification-chain increment complete: topology tests now reject public `session/index.ts` regressions where `createSession()` or `resumeSession()` call `sessionRuntimeFactory.create/resume` directly instead of entering the package-local lifecycle facade.
- Twenty-third verification-chain increment complete: session factory tests now call package-local lifecycle functions directly and prove `resumeSession()`/`forkSession()` reject `persistSession: false` before touching the runtime factory. Topology tests also reject moving those guard strings back into the public `session/index.ts` entry.
- Twenty-fourth verification-chain increment complete: topology tests now require `SessionRuntimeFactory` and the default runtime factory to stay limited to `create()`/`resume()` primitives, preventing future `fork()` or `prompt()` runtime hooks from bypassing package-local lifecycle ownership.
- Twenty-fifth verification-chain increment complete: package verification now rejects packed `@blade-ai/agent-sdk` session factory declarations that expose `fork(options)` or `prompt(message)`, so the published `SessionRuntimeFactory` contract remains a narrow `create()`/`resume()` primitive port.
- Twenty-sixth verification-chain increment complete: topology tests now reject static `legacySessionAdapter` imports from the default session runtime factory and require the adapter to be loaded through `import('./legacySessionAdapter.js')`, preserving a lazy boundary around the remaining root session implementation.
- Twenty-seventh verification-chain increment complete: `pnpm run verify:packages` now extracts the packed `@blade-ai/agent-sdk` tarball, walks the static import closure from `package/dist/session/index.js`, and rejects eager inclusion of legacy root session runtime markers while still permitting the temporary adapter to remain behind a dynamic `import()` boundary.

Commit:

- `ci: add production verification chain`

### Phase 6: Release Automation

Objective: Publish packages automatically from `main` when all gates pass.

Deliverables:

- semantic-release configured for monorepo packages.
- npm trusted publishing/provenance preserved.
- package changelogs or release notes generated per package.
- release workflow runs `pnpm run verify` before publishing.
- dry-run release workflow or command documented.

Status:

- First release-automation increment complete: semantic-release now uses a fixed-version monorepo release for `@blade-ai/ai`, `@blade-ai/agent`, and `@blade-ai/agent-sdk`. The release workflow still runs `pnpm run verify` before publishing, uses GitHub OIDC trusted publishing without `NPM_TOKEN`, and publishes all three package roots through `@semantic-release/npm`. A local prepare plugin synchronizes each package manifest to `nextRelease.version` and rewrites internal `workspace:*` dependencies to the same concrete version before npm publish. `pnpm run release:dry` remains the tokened release rehearsal path without publishing.
- Second release-automation increment complete: release notes now include a generated per-package section for the fixed-version monorepo release, listing the published `@blade-ai/ai`, `@blade-ai/agent`, and `@blade-ai/agent-sdk` versions plus the session-first install command after the conventional commit notes.

Commit:

- `ci: publish monorepo packages from main`

### Phase 7: Documentation and Examples

Objective: Make the new architecture clear for users and agents.

Deliverables:

- Architecture guide.
- Package guide.
- Session-first quickstart.
- Provider guide.
- Tool authoring guide.
- Server/Next.js guide.
- Browser-safe/remote-client guide.
- Production checklist.

Status:

- First documentation increment complete: VitePress now includes an architecture guide and package/entrypoint guide. The architecture guide documents the `@blade-ai/ai` / `@blade-ai/agent` / `@blade-ai/agent-sdk` responsibilities, dependency direction, runtime boundaries, observability boundaries, and production verification gates. The package guide documents recommended imports, Browser-safe vs Server / CLI boundaries, direct `@blade-ai/ai` provider usage, runtime-independent `@blade-ai/agent` usage, and session-first `@blade-ai/agent-sdk` usage.
- Second documentation increment complete: a session-first quickstart now documents the server/CLI `createSession()` flow, explicitly calls out `allowedTools: []` as disabling all tools, links to `examples/session-first-server.ts`, and adds `pnpm run verify:examples` to the root verification chain so the public quickstart import remains type-checked.
- Third documentation increment complete: a Server / Next.js guide now documents Route Handler and Server Action usage, keeps root `createSession()` server-only, requires `runtime = 'nodejs'` for Route Handlers, and tells browser clients to communicate over HTTP while importing only browser-safe `core` / `tools` contracts.
- Fourth documentation increment complete: a Browser Remote Client guide now documents browser-safe `core` / `browser` imports, remote HTTP NDJSON streaming with `StreamMessage`, server-only stub behavior, and the production boundary that keeps provider keys, tools, MCP, filesystem, shell, and sandbox execution on the server.
- Fifth documentation increment complete: a Production Checklist now documents the required `pnpm run verify` release gate, package boundary checks, browser-safe entrypoint checks, optional GLM live smoke, release dry-run, and trusted publishing flow from `main`.
- Sixth documentation increment complete: a Provider and model guide now documents session-first provider configuration, direct `@blade-ai/ai` `ModelPort` usage, OpenAI-compatible/GLM smoke testing, Vercel provider adapters, stream events, usage normalization, and the boundary that keeps `@blade-ai/agent` independent of provider SDKs.
- Seventh documentation increment complete: a Tool Authoring guide now documents production custom tool design for session-first apps, browser-safe tool imports, `defineTool` / `createTool`, `ExecutionContext`, allowed-tool policy, permission update effects, stream event mapping, and verification expectations.

Commit:

- `docs: document production agent sdk architecture`

## Completion Criteria

The migration is complete only when all of the following are true:

- The repo has `packages/ai`, `packages/agent`, and `packages/agent-sdk`.
- `@blade-ai/agent-sdk` still supports session-first `createSession()`.
- `@blade-ai/agent` is proven free of Node-local runtime dependencies.
- `@blade-ai/ai` owns provider execution and usage normalization.
- Existing session, tools, hooks, observability, permission, and token budget behavior is covered by tests.
- CI verifies lint, type-check, build, unit, integration, package exports, browser safety, docs, and pack/install.
- Pushes to `main` can publish automatically after gates pass.
- Documentation describes the package boundaries and recommended usage.
