# Production Agent SDK Monorepo Roadmap

## Goal

Rebuild Blade Agent SDK into a production-grade, Pi-inspired monorepo with three core packages:

- `@blade-ai/ai`: provider-agnostic model API, streaming, usage, pricing, provider options.
- `@blade-ai/agent`: runtime-independent agent kernel, loop contracts, tool calling protocol, state, traces, permissions.
- `@blade-ai/agent-sdk`: session-first product SDK that composes `ai`, `agent`, and local/server adapters.

The public experience remains session-first:

```ts
import { createSession } from '@blade-ai/agent-sdk';
```

Backward compatibility is not a constraint. Architecture correctness, production quality, clear types, and agent-friendly APIs take priority.

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
