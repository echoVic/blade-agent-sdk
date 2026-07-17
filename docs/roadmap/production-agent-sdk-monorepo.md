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

- `pnpm run type-check` — zero errors in root and all packages
- `pnpm run verify:boundaries` — package boundary verification passed
- `pnpm run test` — all tests pass (stable subset; pre-existing failures tracked separately)
- Individual consumer type-checks against public API surface

---

## Migration Progress — 101 Slices Completed

### Subsystems at 100% (Complete)

| # | Subsystem | Slices | Files |
|---|---|---|---|
| 1 | **Branded Types** | #38 | SessionId, MessageId, etc. in package |
| 2 | **Constants** | #62-66 | HookEvent, MessageRole, PermissionMode, PermissionDecision, StreamMessageType |
| 3 | **Observability** | #59-60, #67-68 | TraceRecorder, types, barrel |
| 4 | **Memory** | #33 | MemoryStore |
| 5 | **Sandbox** | #29-31 | SandboxExecutor, SandboxService |
| 6 | **Errors** | #32 | Error types barrel |
| 7 | **Logging** | #58, #69-70 | StreamDebugLogger, Logger, loggingTypes |
| 8 | **Runtime** | #71-77 | RuntimeContext, utils, RuntimePatch, RuntimeContextPatch, ContextSnapshot, messageUtils, barrel |
| 9 | **Lifecycle** | #78 | CleanupRegistry |
| 10 | **Services** | #79 | FileSystemService |
| 11 | **Prompts** | #80-82, #87 | default, types, builder, barrel |
| 12 | **Skills** | #83-86, #88-89 | types, activation, SkillLoader, SkillRegistry, injectSkillsMetadata, barrel |
| 13 | **Permissions** | #93, #95 | Types (PermissionRuleValue, PermissionUpdate, PermissionResult, ToolEffect) + runtime handlers |
| 14 | **Tools/types** | #91, #94 | ToolMetadata, ToolEffects (ToolKind/ToolResult already shimmed) |
| 15 | **Others** | #36, #38, #41-54 | Context/storage (7/8), hooks (7/10), MCP opened (3/6) |

### Key Migration Patterns

- **Zero-import migrations** (#78, #79, #80, #81, #84, #86, #92): files with ZERO root imports — simplest migrations
- **1-import-change migrations** (#56, #58, #70, #71, #73, #75, #91, #94): single import change to package path
- **2-import-change migrations** (#76, #83, #90): two import changes
- **Barrel simplifications** (#57, #60, #68, #82, #88): partial re-export from package
- **Circular dep break** (#93): extracted 4 intertwined types from 2 files into single package file
- **Constants unification** (#62-66): 5 constants migrated from root to package, root file now pure re-export

### Remaining Work

| Area | Files | Complexity |
|---|---|---|
| **Hooks** | HookExecutor (1243L), HookRuntime (753L), HookManager (1623L) | Blocked by agent/session types; types/schemas migrated in #96 |
| **MCP** | HealthMonitor, createMcpTool, McpClient, McpRegistry | Internal circular deps (auth, health check) |
| **Context** | ContextManager (736L), CompactionService, PersistentStore (875L) | Blocked by session/hooks; strategies migrated in #97, processors in #98 |
| **Tools/types** | ExecutionTypes (58L), ToolDefinition (138L) | Blocked by agent/tools catalog; toolSearch migrated in #99 |
| **Agent/Session** | Many files | Deeply coupled to session infrastructure |

### Verification Status

- ✅ Type-check: 0 errors (root + all packages)
- ✅ Boundaries: green
- ✅ 101 conventional commits
- ⚠️ `pnpm run verify` shows 22 pre-existing lint warnings (not migration-related)
- ⚠️ Test suite has 22 pre-existing test file failures (not migration-related)
