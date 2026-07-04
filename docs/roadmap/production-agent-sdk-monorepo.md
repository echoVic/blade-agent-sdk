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
- `pnpm run test:live:glm` builds `@blade-ai/ai` and verifies one non-streaming plus one streaming request against a GLM/OpenAI-compatible endpoint using `.env` credentials.

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
