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

## Migration Progress — 165 Slices Completed

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
| **MCP** | HealthMonitor, createMcpTool, McpClient, McpRegistry | Internal circular deps; auth shimmed (#104-#108), health types extracted (#109), capability projector decoupled (#117), server info types extracted (#119) |
| **Context** | ContextManager (736L), CompactionService, PersistentStore (875L) | Blocked by session/hooks; strategies migrated in #97, processors in #98 |
| **Tools/types** | ExecutionTypes (58L), ToolDefinition (138L) | Type adapters between root and package; blocked by agent/tools catalog |
| **Agent/Session** | Many files | Deeply coupled to session infrastructure |

### Verification Status

- ✅ Type-check: 0 errors (root + all packages)
- ✅ Boundaries: green
- ✅ 165 conventional commits
- ⚠️ `pnpm run verify` shows 22 pre-existing lint warnings (not migration-related)
- ⚠️ Test suite has 22 pre-existing test file failures (not migration-related)

### Migration Audit (After Slices #96-#120)

**Shimmed root files:** 25 files marked `⚠️ MIGRATED`
**Non-shimmed root files:** 67 files with real code
**Total root reduction:** ~3,955 lines
**Packages populated:**
- `@blade-ai/ai` — model abstraction, chat, providers, streams
- `@blade-ai/agent` — ConversationState, kernel, state, budget, recovery, tracing, protocol, ports
- `@blade-ai/agent-sdk` — 20+ capabilities (hooks, context, tools, MCP, skills, OAuth, memory, session adapters, types)

**Remaining coupled subsystems:**
- Agent loop (Agent.ts 22K, LoopRunner 14K, LoopHookBuilder 14K)
- Context (ContextManager 20K, CompactionService 17K, PersistentStore)
- Hooks (HookRuntime 753L)

### Slice #144 — HookExecutor Migration

**Capability:** Hook command execution and output parsing (`HookExecutor`)
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/hooks/HookExecutor.ts` → re-export from `@blade-ai/agent-sdk/local`
**New test:** `packages/agent-sdk/src/__tests__/localHookExecutor.test.ts` (2 tests)
**Type adjustments:** Aligned return types to match agent-sdk's stricter `HookSpecificOutput` union (property names, required fields)
**Notes:** `HookRuntime` remains blocked by `UserMessageContent`/`HookCallback`/`HookInput` session types

### Slice #145 — HookManager Migration

**Capability:** Hook configuration management, singleton orchestration of HookExecutor
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/hooks/HookManager.ts` → re-export from `@blade-ai/agent-sdk/local`
**New test:** `packages/agent-sdk/src/__tests__/localHookManager.test.ts` (3 tests: instantiation, singleton, default disabled)
**Pre-requisite:** Added 3 missing methods to HookExecutor (`executeCwdChangedHooks`, `executeFileChangedHooks`, `executeInstructionsLoadedHooks`)
**Type adjustments:** Aligned 10 hook input types to match agent-sdk stricter definitions (was_successful→success, task_summary→result_summary+task_id, strategy→trigger+messages_before, error_type→reason, elicitation_id→server_name, added source/was_cancelled)
**Notes:** `reloadConfig` uses `node:fs/promises` (Node-only, appropriate for `/local`)

### Slice #146 — HealthMonitor Migration

**Capability:** MCP connection health monitoring with auto-reconnection
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/mcp/HealthMonitor.ts` → re-export from `@blade-ai/agent-sdk/local`
**Pre-requisite:** Defined `McpClientLike` interface in `mcpTypes.ts` to decouple from concrete `McpClient`
**New test:** `packages/agent-sdk/src/__tests__/localHealthMonitor.test.ts` (3 tests: instantiation, initial status, statistics shape)
**Type adjustments:** Replaced `McpClient` (root class) with `McpClientLike` (agent-sdk interface); changed self-referencing `@blade-ai/agent-sdk/local` imports to relative paths
**Notes:** Extends Node `EventEmitter` — Node-only, appropriate for `/local`

### Slice #147 — McpClient Migration

**Capability:** MCP client with connection management, OAuth, health monitoring, retry, error classification
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/mcp/McpClient.ts` → re-export from `@blade-ai/agent-sdk/local`
**Pre-requisite:** HealthMonitor decoupled via `McpClientLike` interface (#146)
**New test:** `packages/agent-sdk/src/__tests__/localMcpClient.test.ts` (3 tests: instantiation, ErrorType enum, EventEmitter)
**Import adjustments:** `toError` from `@blade-ai/agent/utils`; `getPackageName/getVersion` from `./packageInfo.js`; `OAuthProvider`/`OAuthTokenStorage` from local files; `types.js` → `mcpTypes.js`
**Notes:** Uses `@modelcontextprotocol/sdk`, `node:events`, `process.env` — Node-only, appropriate for `/local`

### Slice #148 — createMcpTool Migration

**Capability:** JSON Schema → Zod conversion for MCP tools; MCP tool definition → Blade Tool factory
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/mcp/createMcpTool.ts` → re-export from `@blade-ai/agent-sdk/local`
**Pre-requisite:** Added `callTool` to `McpClientLike` interface; McpClient migrated (#147)
**New test:** `packages/agent-sdk/src/__tests__/localCreateMcpTool.test.ts` (1 test)
**Import adjustments:** `createTool` from agent-sdk's `../tools/index.js`; `ToolKind` from `../tools/types/ToolKind.js`; `ToolErrorType` from `../tools/types/index.js`; `McpClientLike`/`McpToolDefinition` from `./mcpTypes.js`; `getErrorMessage` from `@blade-ai/agent/utils`; replaced `z.discriminatedUnion` with `z.union` for oneOf fallback
**Notes:** JSON Schema → Zod converter is platform-agnostic (no Node APIs); the agent-sdk already had a simpler `createMcpTool` in `defaultMcpRuntime.ts` but this version adds schema validation

### Slice #149 — McpRegistry Migration (MCP Complete!)

**Capability:** MCP server registry, connection lifecycle, tool discovery, `per-session` instances
**Target:** `@blade-ai/agent-sdk/local`
**Root file shimmed:** `src/mcp/McpRegistry.ts` → re-export from `@blade-ai/agent-sdk/local`
**Fixes:** Added `inProcessHandle` to `McpClientOptions` (regression from #147); removed duplicate `McpServerInfo` type from barrel (already exported from `mcpServerTypes.js`)
**Type adjustments:** Adapted `new McpClient(...)` calls from legacy 5-arg to new 3-arg signature; `types.js` → `mcpTypes.js`; `toError` from `@blade-ai/agent/utils`
**New test:** `packages/agent-sdk/src/__tests__/localMcpRegistry.test.ts` (3 tests: instantiation, statistics, empty server list)
**Milestone:** 🎉 **MCP subsystem fully migrated** — all 6 files (HealthMonitor #146, McpClient #147, createMcpTool #148, McpRegistry #149, + SdkMcpServer/auth/types shimmed earlier) now live in `@blade-ai/agent-sdk/local`

### Slice #150 — ExecutionTypes Migration

**Capability:** Tool execution context types (`ExecutionContext`, `ExecutionHistoryEntry`) and `getEffectiveProjectDir` utility
**Target:** `@blade-ai/agent-sdk/tools/types`
**Root file shimmed:** `src/tools/types/ExecutionTypes.ts` → re-export from `@blade-ai/agent-sdk/tools/types`
**New test:** `packages/agent-sdk/src/__tests__/localExecutionTypes.test.ts` (3 tests: utility function, undefined cwd, type shape)
**Import adjustments:** `@blade-ai/agent-sdk/tools` → `../public-index.js`; `@blade-ai/agent-sdk/local` → `../../local/index.js`; `../../runtime/index.js` → `../../local/ContextSnapshot.js`; `../../types/branded.js` → `../../local/branded.js`; `./ToolResult.js` → `../index.js`; `../../types/common.js` → `../../types/common.js` (same)
**Notes:** Pure type definitions with one small runtime utility; first tools/types migration — opens path for ToolDefinition, ToolCatalog, ToolRegistry

### Slice #151 — ToolDefinition Migration

**Capability:** Core tool type definitions (`Tool`, `ToolConfig`, `ToolDefinition`, `ToolInvocation`, `ToolDescription`, `ToolSchema`, `ToolDescriptionResolver`)
**Target:** `@blade-ai/agent-sdk/tools/types`
**Root file shimmed:** `src/tools/types/ToolDefinition.ts` → re-export from `@blade-ai/agent-sdk/tools/types`
**New test:** `packages/agent-sdk/src/__tests__/localToolDefinition.test.ts` (3 tests: type exports, ToolDescriptionResolver, ToolInvocation)
**Import adjustments:** `@blade-ai/agent-sdk/local` → `../../local/toolDefinitionTypes.js`; `./ToolResult.js` → `../index.js`; all others unchanged (same relative paths from agent-sdk)
**Notes:** Pure type definitions (no runtime code); split re-export from single `export type` to import+re-export pattern to make types available in file scope; second tools/types file migrated (#150 + #151) — progress toward tools subsystem completion

### Slice #152 — ToolRegistry Migration

**Capability:** Runtime tool registry (Map-based, alias support, category/tag indexing, MCP tool management, function declaration generation, permission-mode filtering)
**Target:** `@blade-ai/agent-sdk/tools/registry`
**Root file shimmed:** `src/tools/registry/ToolRegistry.ts` → re-export from `@blade-ai/agent-sdk/tools/registry`
**New test:** `packages/agent-sdk/src/__tests__/localToolRegistry.test.ts` (8 tests: instantiation, register/retrieve, duplicate throw, unregister, tag query, category query, search, statistics)
**Import adjustments:** `../../utils/errorUtils.js` → `@blade-ai/agent/utils`; `../search/toolSearch.js` → `../toolSearch.js`; `resolveToolBehaviorHint` → `../types/ToolKind.js`; `PermissionMode` enum values: `Default`→`DEFAULT`, `AcceptEdits`→`AUTO_EDIT`, `Bypass`→`YOLO`, `Plan`→`PLAN`
**Notes:** First non-type tools file migrated to agent-sdk; 409L of runtime code with registration, querying, function declarations, MCP tool management; opens path for ToolCatalog (#153)

### Slice #153 — ToolCatalog Migration

**Capability:** Tool catalog with source tracking (ToolSourceInfo/kind/trustLevel), registry delegation, MCP tool registration/removal, function declaration generation, permission-mode filtering
**Target:** `@blade-ai/agent-sdk/tools/catalog`
**Root file shimmed:** `src/tools/catalog/ToolCatalog.ts` → re-export from `@blade-ai/agent-sdk/tools/catalog`
**New test:** `packages/agent-sdk/src/__tests__/localToolCatalog.test.ts` (8 tests: instantiation, register, entries with source info, unregister, declarations, search, MCP registration, MCP removal by server name)
**Import adjustments:** `../search/toolSearch.js` → `../toolSearch.js` (flat directory); `@blade-ai/agent-sdk/local` → `../public-index.js` (types are in tools barrel, not local)
**Notes:** Fifth tools file migrated (#150-#154); completed another tools/exposure directory (after types, registry, catalog); remaining tools: createTool (644L), builtin/index (49L)

### Slice #155 — createTool Migration

**Capability:** Tool factory function (Zod schema parsing, JSON Schema generation, validation, error handling, `UnifiedToolInvocation`, `parseWithZod`, `formatZodError`, `translateZodIssue`) — the largest tools migration at 644 lines
**Target:** `@blade-ai/agent-sdk/tools/core`
**Root file shimmed:** `src/tools/core/createTool.ts` → re-export from `@blade-ai/agent-sdk/tools/core`
**New test:** `packages/agent-sdk/src/__tests__/localCreateTool.test.ts` (6 tests: creation, function declaration, describe, build+execute, direct execute, error handling)
**Import adjustments:** `validationErrorToToolResult` → `../index.js` (tools barrel, not types barrel); `getFunctionDeclaration()` parameters cast: `JSONSchema7 → FunctionDeclaration['parameters']`; `getMetadata()` return cast: `as ReturnType<Tool['getMetadata']>` (agent-sdk has optional `displayName?` and `schema: JsonObject | JsonSchemaObject`)
### Slice #156 — getBuiltinTools Migration (Tools Subsystem Complete!)

**Capability:** Builtin tools loader (delegates to agent-sdk/local, adds MCP protocol tools support via McpRegistry, optional subagent loading via SubagentRegistryLike)
**Target:** `@blade-ai/agent-sdk/tools/builtin`
**Root file shimmed:** `src/tools/builtin/index.ts` → re-export from `@blade-ai/agent-sdk/tools/builtin`
**New interface:** `SubagentRegistryLike` (following `McpClientLike` pattern) in `packages/agent-sdk/src/local/subagentTypes.ts` — decouples from root `SubagentRegistry`
**New test:** `packages/agent-sdk/src/__tests__/localGetBuiltinTools.test.ts` (1 test, interface compatibility)
**Breaking change:** Agent-sdk implementation no longer creates a default `SubagentRegistry` — callers must provide one via `opts.subagentRegistry`
**Milestone:** 🎉 **Tools subsystem fully migrated** — all 7 non-trivial files (#150-#156) now live in `@blade-ai/agent-sdk/tools/*`

### Slice #157 — AgentSessionStatus Type Extraction

**Capability:** Extract `AgentSessionStatus` type (zero-dependency string union: `'running' | 'completed' | 'failed' | 'cancelled'`) to agent-sdk, breaking circular dependency between `agent/types.ts` and `AgentSessionStore.ts`
**Target:** `@blade-ai/agent-sdk/local` (via `agentSessionTypes.ts`)
**Root file updated:** `src/agent/subagents/AgentSessionStore.ts` — local type definition replaced with re-export from `@blade-ai/agent-sdk/local`
**New file:** `packages/agent-sdk/src/local/agentSessionTypes.ts` (4 lines)
**New test:** None (pure type extraction — no runtime behavior)
**Notes:** First agent-subsystem type migration; uses same pattern as type extractions (#150, #151); opens path for further agent type migration (#158: `AgentSession` interface extraction)

### Slice #158 — AgentSession Interface Extraction

**Capability:** Extract `AgentSession` interface (13 properties: id, subagentType, description, prompt, messages, status, result, stats, createdAt, lastActiveAt, completedAt, parentSessionId, outputFile, progress) to agent-sdk/local
**Target:** `@blade-ai/agent-sdk/local` (via `agentSessionTypes.ts`, extends #157)
**Root file updated:** `src/agent/subagents/AgentSessionStore.ts` — interface definition replaced with re-export from `@blade-ai/agent-sdk/local`
**Dependencies resolved:** `AgentId` → branded.ts ✅, `Message` → @blade-ai/ai/chat ✅, `AgentSessionStatus` → #157 ✅, `AgentProgress` → agentTypes.ts (already in agent-sdk) ✅
**New test:** None (pure type extraction — verified via type-check)
**Strategic impact:** Breaks circular dependency between `agent/types.ts` (imports `AgentSession`) and `AgentSessionStore.ts` (imports `AgentProgress`); `agent/types.ts` now has only 1 remaining non-shimmed import: `StartBackgroundAgentOptions` from `BackgroundAgentManager`

### Slice #159 — Agent Loop Types Extraction

**Capability:** Extract self-contained agent loop types (`AgentOptions`, `LoopOptions`, `LoopResult`, `PlanApprovalResult`) and runtime type guard (`isPlanApprovalResult`) to agent-sdk/local/agentLoopTypes.ts
**Target:** `@blade-ai/agent-sdk/local` (via `agentLoopTypes.ts`)
**Root file updated:** `src/agent/types.ts` — 5 inline definitions replaced with re-exports from `@blade-ai/agent-sdk/local`
**New test:** `packages/agent-sdk/src/__tests__/localAgentLoopTypes.test.ts` (4 tests: PlanApprovalResult detection, undefined, no targetMode, no metadata)
**Dependencies:** All 12 type imports from packages or already-shimmed agent-sdk sources; zero root-specific dependencies
**Notes:** First slice with runtime code in the agent subsystem migration (type guard function); AgentOptions has PermissionsConfig, PermissionMode, ToolCatalogSourcePolicy, TokenBudgetConfig dependencies — all resolved via agent-sdk; reduces `agent/types.ts` from 149L to ~100L

### Slice #160 — AgentEvent.ts Full File Migration

**Capability:** Complete AgentEvent event type system (26 event interfaces + AgentEvent union type + TokenUsageInfo) — 249 lines migrated from root to agent-sdk/local/agentEvent.ts
**Target:** `@blade-ai/agent-sdk/local` (via `agentEvent.ts`)
**Root file shimmed:** `src/agent/AgentEvent.ts` → full re-export shim (27 type exports)
**New barrel export:** All 27 AgentEvent types added to local/index.ts
**Import adjustments:** `RuntimePatch/RuntimeContextPatch` → `./RuntimePatch.js`, `./RuntimeContextPatch.js`; `TodoItem` → `./todo/types.js`; `ToolResult` → `../tools/index.js`; `PermissionUpdate` → `../types/permissions.js`
**Notes:** First full agent file migration (#160); all 7 imports resolved to agent-sdk local files or external packages; zero root-specific dependencies; pure type file (no runtime code); marks transition from type extraction (#157-#159) to complete file migration in the agent subsystem

### Slice #161 — PlanExecutor Runtime Class Migration

**Capability:** PlanExecutor class (plan mode execution flow: injectPlanReminder, buildPlanSystemPrompt, runPlanLoop, runPlanLoopStream) — 99 lines migrated to agent-sdk/local/planExecutor.ts
**Target:** `@blade-ai/agent-sdk/local` (via `planExecutor.ts`)
**Root file shimmed:** `src/agent/PlanExecutor.ts` → simple re-export shim
**New test:** `packages/agent-sdk/src/__tests__/localPlanExecutor.test.ts` (4 tests: instantiation, string reminder injection, content part injection, non-text prepend)
**Import adjustments:** `buildSystemPrompt` → `./promptBuilder.js`, `createPlanModeReminder` → `./prompts.js`, `Logger` → `./Logger.js`, `AgentEvent` → `./agentEvent.js`, `ChatContext/UserMessageContent` → `./agentTypes.js`, `LoopOptions/LoopResult` → `./agentLoopTypes.js`
**Notes:** Second full agent file migration (#160-#161); first runtime class in agent subsystem; 4/4 tests pass; all 5 import groups resolved to agent-sdk local files

### Slice #162 — TurnState Type Migration

**Capability:** TurnState type system (LlmToolDefinition, LoopSkillState, LoopRecoveryState, LoopExecutionContext, TurnState) — 53 lines migrated to agent-sdk/local/turnState.ts
**Target:** `@blade-ai/agent-sdk/local` (via `turnState.ts`)
**Root file shimmed:** `src/agent/state/TurnState.ts` → re-export shim
**Import adjustments:** All 6 import groups resolved to agent-sdk local files: `ContextSnapshot` → `./ContextSnapshot.js`, `ToolRegistryLike` → `./kernelAdapterTypes.js`, `BackgroundAgentManagerLike/ConfirmationHandlerLike/ToolCatalogLike` → `./turnStateTypes.js`, `SessionId` → `./branded.js`, `BladeConfig/PermissionMode` → `../types/common.js`
**Notes:** Third full agent file migration (#160-#162); all 6 imports from agent-sdk local or packages; zero root dependencies; fastest slice — all imports pre-verified, zero type errors on first attempt

### Slice #163 — LoopState Runtime Class Migration

**Capability:** LoopState runtime class (15 methods: buildTurnState, getTools, getChatService, recovery lifecycle, skill management, context snapshot) — 133 lines migrated to agent-sdk/local/loopState.ts
**Target:** `@blade-ai/agent-sdk/local` (via `loopState.ts`)
**Root file shimmed:** `src/agent/state/LoopState.ts` → re-export shim
**New test:** `packages/agent-sdk/src/__tests__/localLoopState.test.ts` (7 tests: instantiation, buildTurnState, getTools, recovery start/reset, active skill, context snapshot)
**Import adjustments:** `ContextSnapshot` → `./ContextSnapshot.js`, `ConversationState` → `import type` from `@blade-ai/agent`, `PermissionMode` → `../types/common.js`, loop types → `./turnState.js`
**Notes:** Fourth full agent file migration (#160-#163); largest runtime class migrated to agent subsystem (133L, 15 methods); 7/7 tests pass; all 5 imports from agent-sdk local or packages, zero root dependencies

### Slice #164 — AttachmentCollector Migration (504L)

**Capability:** AttachmentCollector class (504L) — file collection from @ mentions, glob pattern support, directory tree rendering, file caching — migrated to agent-sdk/local/attachmentCollector.ts
**Target:** `@blade-ai/agent-sdk/local` (via `attachmentCollector.ts`)
**Root file shimmed:** `src/prompts/processors/AttachmentCollector.ts` → re-export shim
**Import adjustments:** All 6 imports resolved: `fast-glob` (external), `fs/promises+path` (Node-only, allowed in agent-sdk), `Logger` → `./Logger.js`, `splitPath` → `@blade-ai/agent/utils`, `PathSecurity` → `./pathSecurity.js`, `AtMentionParser` → `./AtMentionParser.js`, `Attachment/CollectorOptions` types → `./promptProcessors.js`
**Notes:** Largest tractable file migration yet (504L); Node-only implementation (fs, fast-glob); first prompts/processors file migrated; zero type errors after fixing splitPath import; marks expansion beyond agent/ directory

### Slice #165 — SubagentRegistry Migration (309L)

**Capability:** SubagentRegistry class (309L) — subagent registration, YAML frontmatter parsing, LLM-readable description generation, builtin/user/project/session source management — migrated to agent-sdk/local/subagentRegistry.ts
**Target:** `@blade-ai/agent-sdk/local` (via `subagentRegistry.ts`)
**Root file shimmed:** `src/agent/subagents/SubagentRegistry.ts` → re-export shim
**Import adjustments:** All 7 imports resolved: `fs/path/yaml` (Node-only, allowed), `Logger` → `./Logger.js`, `builtinAgents` → `../subagents/builtinAgents.js`, `SubagentConfig/Frontmatter/Source + mapClaudeCodePermissionMode` → `../subagents/types.js`
**Notes:** Largest agent subagent file migrated; all imports resolved to agent-sdk or external packages; zero type errors; Node-only dependencies (fs, path, yaml) allowed in agent-sdk; further unlocks agent/session cross-dependencies

**Notes:** Sixth tools file migrated (#150-#155); all 5 core tools subdirectories now have files in agent-sdk (types, registry, catalog, exposure, core); completes the horizontal tool subsystem migration

### Slice #154 — ToolExposurePlanner Migration

**Capability:** Tool exposure planning (declaration generation, exposure mode resolution, runtime policy filtering, allow/deny selectors, discoverable tool entries)
**Target:** `@blade-ai/agent-sdk/tools/exposure`
**Root file shimmed:** `src/tools/exposure/ToolExposurePlanner.ts` → re-export from `@blade-ai/agent-sdk/tools/exposure`
**New test:** `packages/agent-sdk/src/__tests__/localToolExposurePlanner.test.ts` (5 tests: instantiation, eager plan, deny policy, deferred mode, discovered tools)
**Import adjustments:** `resolveToolBehaviorHint` → `../types/ToolKind.js`; `RuntimeToolPolicySnapshot` → separate import+re-export pattern; `tool.exposure` → `tool.exposure?.` (null safety); `displayName` → `tool.displayName ?? tool.name` (agent-sdk optional property)
**Notes:** Fifth tools file migrated (#150-#154); completed another tools/exposure directory (after types, registry, catalog); remaining tools: createTool (644L), builtin/index (49L)
