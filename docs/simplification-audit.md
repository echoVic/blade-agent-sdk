# Codebase Simplification Audit — `@blade-ai/agent-sdk`

> **Audit date**: 2026-08-20
> **Scope**: Full repository (`src/`, `scripts/`, entry points)
> **Production LOC**: ~47,000 TypeScript (non-test)
> **Status**: Audit-only — no files were modified

---

## 1. Subsystem Inventory (Coverage Contract)

| ID | Subsystem | Ownership Boundary | Key Files | Status |
|----|-----------|--------------------|-----------|--------|
| S1 | Agent Loop | `src/agent/` (excl. subagents) | AgentLoop.ts, LoopState.ts, TurnState.ts, ConversationState.ts, runTurn.ts, executeToolCalls.ts | recommend |
| S2 | Session | `src/session/` | Session.ts, SessionRuntime.ts, SessionStore.ts, types.ts | recommend |
| S3 | Tools Infrastructure | `src/tools/` (excl. builtin) | ExecutionPipeline.ts, ConcurrencyScheduler.ts, ToolCatalog.ts, ToolRegistry.ts, ToolExposurePlanner.ts | recommend |
| S4 | Hooks System | `src/hooks/` | HookRuntime.ts, HookExecutor.ts, HookManager.ts, OutputParser.ts, types/HookTypes.ts | recommend |
| S5 | Context & Compaction | `src/context/` | CompactionService.ts, PersistentStore.ts, JSONLStore.ts, ContextManager.ts | recommend |
| S6 | MCP | `src/mcp/` + `tools/builtin/mcp/` | McpRegistry.ts, McpClient.ts, createMcpTool.ts | recommend |
| S7 | Subagents | `src/agent/subagents/` | SubagentExecutor.ts, BackgroundAgentManager.ts, AgentSessionStore.ts | recommend |
| S8 | Services | `src/services/` | VercelAIChatService.ts, deepseek.ts, RetryPolicy.ts | recommend |
| S9 | Builtin Tools | `src/tools/builtin/` | web/searchProviders.ts, web/webSearch.ts, file/edit.ts, file/write.ts | recommend |
| S10 | Sandbox | `src/sandbox/` | SandboxService.ts, SandboxExecutor.ts | recommend |
| S11 | Prompts | `src/prompts/` | processors/types.ts, AttachmentCollector.ts, AttachmentHandler.ts | recommend |
| S12 | Memory | `src/memory/` | MemoryManager.ts, FileSystemMemoryStore.ts | skip |
| S13 | Runtime | `src/runtime/` | RuntimeContext.ts, ContextSnapshot.ts, RuntimePatch.ts | skip |
| S14 | Skills | `src/skills/` | SkillRegistry.ts, SkillLoader.ts, activation.ts | skip |
| S15 | Types & Constants | `src/types/` | common.ts, constants.ts, permissions.ts, branded.ts | skip |
| S16 | Errors | `src/errors/` | SdkError.ts, AbortError.ts, ToolExecutionError.ts, PermissionDeniedError.ts, ConfigError.ts | skip |
| S17 | Utils | `src/utils/` | errorUtils.ts, pathSecurity.ts, modelDetection.ts, pathHelpers.ts, filePatterns.ts | skip |
| S18 | Observability | `src/observability/` | TraceRecorder.ts, types.ts | skip |
| S19 | Lifecycle | `src/lifecycle/` | CleanupRegistry.ts | skip |
| S20 | Logging | `src/logging/` | Logger.ts, StreamDebugLogger.ts | skip |
| S21 | Platform Entries | `src/browser/`, `src/local/`, `src/server/`, `src/core/` | Re-export barrels only | skip |
| S22 | Scripts/Tooling | `scripts/` | release.js, release-utils.js, download-ripgrep.js (600 LoC total) | skip |

---

## 2. Confirmed Opportunities

Findings are ranked by concrete impact, confidence, implementation effort, and blast radius.

---

### Priority 1 — Bug Fix + Simplification

#### F1. MCP Registry: Stale `lastError` after auto-reconnection [S6]

- **Confidence**: high
- **Evidence**:
  - [McpRegistry.ts:417-420](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/mcp/McpRegistry.ts#L417-L420) — the `'connected'` event handler sets `status`, `connectedAt`, `tools` but never clears `lastError`.
  - After `handleUnexpectedClose` (L331) sets `lastError` via the `'error'` event, a subsequent auto-reconnect via `scheduleReconnect` (L350) will set `status: CONNECTED` while leaving `lastError` populated.
  - The imperative path at [L158](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/mcp/McpRegistry.ts#L158) correctly clears `lastError`, but the event-driven auto-reconnect path does not.
- **Current complexity / invalid states**:
  - `McpServerInfo` exposes `status: CONNECTED` alongside `lastError: Error("MCP服务器连接意外关闭")`.
  - `McpCapabilityProjector` at line 66 reads `serverInfo.lastError?.message` and reports a stale error for healthy servers.
- **Proposed representation**:
  - Add `serverInfo.lastError = undefined` in the `'connected'` handler (1-line fix).
  - Consolidate the duplicated try-catch between `connectServer` ([L153-164](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/mcp/McpRegistry.ts#L153-L164)) and `reconnectServer` ([L198-209](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/mcp/McpRegistry.ts#L198-L209)) by making `reconnectServer` delegate to `connectServer` after disconnecting. Event handlers keep `serverInfo` in sync throughout.
- **Smallest credible scope**:
  - `src/mcp/McpRegistry.ts` — ~15 changed lines.
- **Regression risks**:
  - Must retain the preemptive `serverInfo.status = CONNECTING` assignment (L154) as a concurrency guard for `waitForServerConnected`.
  - Event emissions from `McpClient` are synchronous (Node EventEmitter); verify no `await` is inserted between `setStatus(CONNECTED)` and the return in `doConnect`.
- **Validation**:
  - Existing: `McpRegistry.test.ts` covers register/connect/disconnect (mocked client).
  - Add: A test that triggers the `'connected'` event after an error event and asserts `serverInfo.lastError` is undefined.

---

### Priority 2 — Discriminated Unions (Invalid States Elimination)

#### F2. Session: Pending-request triple → `RequestPhase` [S2]

- **Confidence**: medium-high
- **Evidence**:
  - [Session.ts:69-71](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/session/Session.ts#L69-L71) — `pendingMessage`, `pendingSendOptions`, `pendingContextSnapshot` are three nullable fields that move in lockstep.
  - Set atomically in `send()` at [L250-257](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/session/Session.ts#L250-L257), consumed at [L268-273](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/session/Session.ts#L268-L273), cleared at [L626-628](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/session/Session.ts#L626-L628).
  - After `stream()` nulls `pendingMessage` on line 271, the guard at [L244](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/session/Session.ts#L244) no longer blocks. A concurrent `send()` during the long-running generator loop (L343-564) can create two generators mutating `this._messages` and overwriting `this.abortController`.
- **Current complexity / invalid states**:
  - 9 null-assignment statements across 3 sites for fields that are always set/cleared together.
  - `initialized` + `closed` + `abortController !== null` encode 8 combinations; only 4 are valid. The "streaming" phase is implicit.
  - Concrete race condition: send-during-streaming can corrupt `_messages` and silently overwrite the abort controller.
- **Proposed representation**:

  ```typescript
  type RequestPhase =
    | { phase: 'idle' }
    | { phase: 'pending'; message: UserMessageContent; options: SendOptions | null; snapshot: ContextSnapshot }
    | { phase: 'streaming'; abortController: AbortController };

  private requestPhase: RequestPhase = { phase: 'idle' };
  ```

  - `send()` checks `this.requestPhase.phase === 'idle'` (rejects both pending and streaming states).
  - `stream()` checks `phase === 'pending'`, destructures the request, transitions to `{ phase: 'streaming', abortController }`.
  - The `finally` block transitions back to `{ phase: 'idle' }`.
- **Smallest credible scope**:
  - `src/session/Session.ts` — replace 4 fields with `RequestPhase`; update `send()`, `stream()`, `close()`, `abort()`.
  - No public interface change.
- **Regression risks**:
  - `abort()` must only transition `requestPhase` if currently streaming.
  - External code reading `this.abortController` (none outside Session.ts per grep).
- **Validation**:
  - Existing: `SessionContext.test.ts`, `SessionInMemoryMode.test.ts` cover sequential send/stream.
  - Add: A test that calls `send()` while a `stream()` generator is suspended and asserts the error.

#### F3. AgentLoop: Recovery state → discriminated union [S1]

- **Confidence**: high
- **Evidence**:
  - [AgentLoop.ts:152-155](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/AgentLoop.ts#L152-L155) — `recoveryAttemptedTurn`, `recoveryAttempt`, `retryCurrentTurn` are three independent local variables.
  - Additionally, `LoopState.recovery`/`TurnState.recovery`/`TurnState.transitionReason` (defined in [LoopState.ts](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/state/LoopState.ts#L34-L38) and [TurnState.ts](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/state/TurnState.ts#L26-L30)) mirror this state but have **zero consumers**. `runTurn.ts` only reads `turnState.tools` and `turnState.chatService`.
- **Current complexity / invalid states**:
  - Combinations like `retryCurrentTurn=true, recoveryAttemptedTurn=null` are representable but nonsensical.
  - Dead mirror state in `LoopState` adds 5 methods (`startRecovery`, `markRecoveryRetry`, `failRecovery`, `resetRecovery`, `getRecoveryState`) and two fields that are never read — maintenance surface with no value.
  - Dead writes: [RuntimePatchManager.ts:176](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/RuntimePatchManager.ts#L176) `setTransitionReason('skill_activated')` and [LoopHookBuilder.ts:261](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/LoopHookBuilder.ts#L261) `setTransitionReason('model_switched')` write to a field nobody reads.
- **Proposed representation**:

  ```typescript
  type RecoveryState =
    | { phase: 'idle' }
    | { phase: 'retry_pending'; turn: number; attempt: number }
    | { phase: 'in_retried_turn'; turn: number; attempt: number };
  ```

  - Remove `LoopRecoveryState`, `LoopState.recovery`, the 5 LoopState methods, and `TurnState.recovery`/`TurnState.transitionReason`.
  - The `hooks.recovery.onStateChange` callback remains for `AgentEvent` emission (observability).
- **Smallest credible scope**:
  - `src/agent/AgentLoop.ts` — replace 3 locals with union (~10 LOC net change).
  - `src/agent/state/LoopState.ts` — remove recovery/transitionReason fields and 5 methods.
  - `src/agent/state/TurnState.ts` — remove `LoopRecoveryState` and two fields.
  - `src/agent/LoopHookBuilder.ts` — remove mirror writes, keep event emission.
  - `src/agent/RuntimePatchManager.ts` — remove dead `setTransitionReason` call.
- **Regression risks**:
  - If any code outside the boundary reads `TurnState.recovery` (confirmed: none via grep), it would break.
- **Validation**:
  - Existing: `AgentLoop.test.ts` lines 413-656 cover recovery via AgentEvent stream (unchanged).

#### F4. HookExecutionResult: Scattered booleans → discriminated union [S4]

- **Confidence**: high
- **Evidence**:
  - [HookTypes.ts:887-917](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/types/HookTypes.ts#L887-L917) — `success: boolean`, `blocking?: boolean`, `needsConfirmation?: boolean` encode four mutually exclusive outcomes but permit 8 combinations.
  - Every consumer in [HookExecutor.ts:80-101](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/HookExecutor.ts#L80-L101) (and ~10 methods total) re-derives the state through nested `if (!result.success) { if (result.blocking) ... }` cascades.
- **Current complexity / invalid states**:
  - `{ success: true, blocking: true }`, `{ blocking: true, needsConfirmation: true }` are contradictory but representable.
  - Three-level conditional repeated ~10 times in HookExecutor.
- **Proposed representation**:

  ```typescript
  type HookExecutionOutcome =
    | { status: 'success'; output?: HookOutput }
    | { status: 'blocked'; error: string }
    | { status: 'warning'; warning: string }
    | { status: 'needs_confirmation'; warning: string };

  export type HookExecutionResult = HookExecutionOutcome & {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hook?: Hook;
  };
  ```

  - Consumers become `switch(result.status)` instead of nested conditionals.
  - The sole producer (`OutputParser.parse`) already has distinct code paths per state.
- **Smallest credible scope**:
  - `types/HookTypes.ts`, `OutputParser.ts`, `HookExecutor.ts`.
  - `__tests__/OutputParser.test.ts` assertions updated from `.success`/`.blocking`/`.needsConfirmation` to `.status`.
- **Regression risks**: Internal-only type; external consumers use per-event result types (`PreToolHookResult`, etc.), not raw `HookExecutionResult`.
- **Validation**: Existing OutputParser tests cover all four states.

#### F5. SearchProvider: Flat interface → discriminated union [S9]

- **Confidence**: high
- **Evidence**:
  - [searchProviders.ts:15-32](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/web/searchProviders.ts#L15-L32) — `SearchProvider` interface has `searchFn?` plus all HTTP fields.
  - Exa provider at [L434-438](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/web/searchProviders.ts#L434-L438) supplies dead stubs: `buildUrl: () => ''`, `parseResponse: () => []`, `getHeaders: () => ({})`.
  - Consumer in [webSearch.ts:185](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/web/webSearch.ts#L185) dispatches on `if (provider.searchFn)`.
- **Current complexity / invalid states**:
  - A provider with `searchFn` but incorrect `parseResponse` cannot be caught by the type system.
  - `endpoint` is required even for SDK providers that don't use it.
  - `buildBody?` is only valid when `method === 'POST'` but that coupling isn't enforced.
- **Proposed representation**:

  ```typescript
  type SearchProvider =
    | { kind: 'http'; name: string; endpoint: string; method?: 'GET' | 'POST';
        buildUrl: (query: string) => string;
        buildBody?: (query: string) => JsonObject;
        parseResponse: (data: JsonValue) => WebSearchResult[];
        getHeaders: () => Record<string, string>; }
    | { kind: 'sdk'; name: string;
        searchFn: (query: string) => Promise<WebSearchResult[]>; };
  ```

- **Smallest credible scope**:
  - `src/tools/builtin/web/searchProviders.ts` (~20 changed lines), `src/tools/builtin/web/webSearch.ts` (change `if (provider.searchFn)` to `if (provider.kind === 'sdk')`).
- **Regression risks**: The type is not exported beyond these two files.
- **Validation**: Type-level change; runtime behavior identical.

#### F6. SandboxCheckResult: Boolean cascade → `outcome` discriminant [S10]

- **Confidence**: high
- **Evidence**:
  - [SandboxService.ts:10-15](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/sandbox/SandboxService.ts#L10-L15) — 3 boolean-like fields create 8-combination space; only 5 outcomes ever produced in `checkCommand` ([L66-93](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/sandbox/SandboxService.ts#L66-L93)).
  - Consumer in `bash.ts:219-237` cascades: `if (allowed) return; if (requiresPermission) return ask; return deny`.
- **Current complexity / invalid states**:
  - `{ allowed: true, requiresPermission: true }`, `{ allowed: false, isExcluded: true }`, `{ allowed: true, requiresPermission: true, isExcluded: true }` are contradictory.
  - `reason?` forces consumers to fallback to default strings.
- **Proposed representation**:

  ```typescript
  export type SandboxCheckOutcome =
    | 'disabled'
    | 'excluded'
    | 'sandboxed'
    | 'requires_permission'
    | 'denied';

  export interface SandboxCheckResult {
    outcome: SandboxCheckOutcome;
    reason: string; // required
  }
  ```

- **Smallest credible scope**:
  - `src/sandbox/SandboxService.ts`, `src/tools/builtin/shell/bash.ts`, test file.
- **Regression risks**: `SandboxCheckResult` is publicly exported via `src/local/index.ts`. **Breaking change** requiring semver major bump. TypeScript catches all consumer breakage at compile time.
- **Validation**: Existing `SandboxService.test.ts` covers all 5 outcomes.

#### F7. Attachment type → proper discriminated union [S11]

- **Confidence**: high
- **Evidence**:
  - [types.ts:53-64](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/prompts/processors/types.ts#L53-L64) — flat `Attachment` interface with `type: 'file' | 'directory' | 'error'` and optional `metadata?`/`error?`.
  - File attachments always include `metadata` ([AttachmentCollector.ts:227-237](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/prompts/processors/AttachmentCollector.ts#L227-L237)); error attachments always set `error` ([L91](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/prompts/processors/AttachmentCollector.ts#L91), [L389-393](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/prompts/processors/AttachmentCollector.ts#L389-L393)).
  - Consumer [AttachmentHandler.ts:77,93](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/AttachmentHandler.ts#L77-L93) uses defensive `att.metadata?.lineRange` even though metadata is always present for files.
- **Proposed representation**:

  ```typescript
  type Attachment = FileAttachment | DirectoryAttachment | ErrorAttachment;

  interface FileAttachment {
    type: 'file'; path: string; content: string;
    metadata: AttachmentMetadata; // required
  }
  interface DirectoryAttachment {
    type: 'directory'; path: string; content: string;
    metadata?: AttachmentMetadata;
  }
  interface ErrorAttachment {
    type: 'error'; path: string; content: '';
    error: string; // required
  }
  ```

- **Smallest credible scope**: `src/prompts/processors/types.ts`, `AttachmentCollector.ts`, `src/agent/AttachmentHandler.ts`.
- **Regression risks**: External consumers accessing `attachment.error` without narrowing get compile errors. The `AttachmentCollector` is the only known producer.

---

### Priority 3 — Duplication Elimination

#### F8. CompactionService: Duplicated message-retention logic [S5]

- **Confidence**: high
- **Evidence**:
  - [CompactionService.ts:186-203](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/CompactionService.ts#L186-L203) and [L483-500](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/CompactionService.ts#L483-L500) — identical 15-line blocks.
  - Only difference: `RETAIN_PERCENT = 0.2` vs `FALLBACK_RETAIN_PERCENT = 0.3`.
- **Current complexity**: The orphan-tool-result filtering invariant (remove `tool` messages whose `tool_call_id` is not in the retained window) is copy-pasted in two places. If this rule needs adjustment, both sites must be updated.
- **Proposed representation**: Extract pure helper `retainRecentMessages(messages: Message[], retainPercent: number): Message[]`.
- **Scope**: 1 file, ~15 lines extracted.
- **Validation**: Add a focused unit test for orphan filtering.

#### F9. SubagentExecutor + BackgroundAgentManager: Duplicated agent-creation [S7]

- **Confidence**: high
- **Evidence**:
  - [SubagentExecutor.ts:36-61](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/subagents/SubagentExecutor.ts#L36-L61) vs [BackgroundAgentManager.ts:259-284](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/subagents/BackgroundAgentManager.ts#L259-L284) — identical `modelId` derivation, `Agent.create` call, `subagentInfo` construction.
  - **Inconsistency**: `SubagentExecutor` passes `systemPrompt` in `ChatContext` (L72); `BackgroundAgentManager` passes it in `Agent.create` options (L263).
- **Proposed representation**: Extract `runSubagentLoop(...)` internal helper; `SubagentExecutor.execute` becomes a thin wrapper, `BackgroundAgentManager.executeAgent` keeps lifecycle/session management around the helper call.
- **Scope**: `SubagentExecutor.ts`, `BackgroundAgentManager.ts` (~30 net lines removed).
- **Validation**: Existing unit tests for both modules cover happy path.

#### F10. File tools: Write-guard protocol duplication [S9]

- **Confidence**: high
- **Evidence**:
  - [edit.ts:130-173](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/file/edit.ts#L130-L173) and [write.ts:124-170](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/file/write.ts#L124-L170) — same 3-step pre-write validation: `hasFileBeenRead` check, `checkExternalModification` check, `SnapshotManager` creation.
  - Both also call `recordFileEdit` post-write ([edit.ts:304](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/file/edit.ts#L304), [write.ts:198](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/builtin/file/write.ts#L198)).
  - Divergence already visible: edit.ts uses `!!(sessionId && messageId)` for `snapshot_created`; write.ts tracks actual outcome.
- **Proposed representation**: Create internal `writeGuard.ts` with `runWriteGuard(...)` and `recordWriteComplete(...)`. Each tool calls two helpers instead of 40+ lines of boilerplate.
- **Scope**: New `src/tools/builtin/file/writeGuard.ts` (~50 lines); edit.ts and write.ts updated.

#### F11. VercelAIChatService: `chat()` duplicates `chatWithRetryEvents()` [S8]

- **Confidence**: high
- **Evidence**:
  - [VercelAIChatService.ts:733-748](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/services/VercelAIChatService.ts#L733-L748) and [L825-840](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/services/VercelAIChatService.ts#L825-L840) — character-for-character identical 15-line `generateText` config blocks wrapped in `withRetry`.
- **Current complexity**: A new `generateText` option must be updated in two places; silent divergence possible.
- **Proposed representation**: `chat()` delegates to `chatWithRetryEvents()` using the existing `consumeRetryGenerator` helper ([L214-228](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/services/VercelAIChatService.ts#L214-L228)).
- **Scope**: 1 file only; ~5 lines replacing 15.

#### F12. DeepSeek: Token-derivation logic duplication [S8]

- **Confidence**: high
- **Evidence**:
  - [deepseek.ts:313-318](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/services/deepseek.ts#L313-L318) (in `calculateDeepSeekCost`) and [L364-372](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/services/deepseek.ts#L364-L372) (in `DeepSeekCostTracker.recordUsage` no-pricing fallback) — identical 4-value cascade derivation.
- **Proposed representation**: Extract unexported `deriveDeepSeekTokenBreakdown(usage): DeepSeekTokenBreakdown` (~8 lines).
- **Scope**: 1 file; no public API change.

#### F13. OutputParser: Behavior-dispatch branching [S4]

- **Confidence**: medium
- **Evidence**:
  - [OutputParser.ts:44-76](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/OutputParser.ts#L44-L76) (timeout), [L87-125](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/OutputParser.ts#L87-L125) (invalid JSON), [L203-239](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/OutputParser.ts#L203-L239) (exit 124), [L243-280](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/hooks/OutputParser.ts#L243-L280) (non-zero exit) — four nearly identical 3-way branches dispatching on `timeoutBehavior`/`failureBehavior` (`deny`/`ask`/`ignore`).
- **Proposed representation**: Private `buildFailureResult(behavior, errorMsg, result, hook): HookExecutionResult` helper (~12 lines). Each call site becomes one line.
- **Scope**: 1 file; ~55 lines net reduction. Pairs naturally with F4 (discriminated union).

---

### Priority 4 — Dead Code Removal

#### F14. ExecutionPipeline: Dead batch execution methods [S3]

- **Confidence**: high
- **Evidence**:
  - `executeAll` ([L318-326](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/execution/ExecutionPipeline.ts#L318-L326)), `executeTools` ([L331-366](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/execution/ExecutionPipeline.ts#L331-L366)), `executeParallel` ([L371-379](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/tools/execution/ExecutionPipeline.ts#L371-L379)), and supporting private methods/types (`partitionToolCalls`, `canExecuteInParallel`, `executeWithConcurrency`, `IndexedToolCallRequest`, `PartitionedToolCallBatch`) have **zero production callers** (confirmed via grep).
  - Agent layer implements its own batching in [executeToolCalls.ts](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/loop/executeToolCalls.ts) using `executionPipeline.execute()` (single-tool) and calls `pipeline.execute()` at [runToolCall.ts:148](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/loop/runToolCall.ts#L148).
- **Current complexity**:
  - The batch path's `partitionToolCalls` forces ALL write/execute tools serial (most restrictive), contradicting `ConcurrencyScheduler`'s design of allowing concurrent writes on different files via `FileLockManager`.
  - `maxConcurrency` config field is dead from a production perspective.
- **Proposed representation**: Remove these methods, their supporting types, and `maxConcurrency` config. `execute()` is the sole entry point.
- **Scope**: `src/tools/execution/ExecutionPipeline.ts` (~90 lines removed); remove 3 batch test cases.
- **Regression risks**: `ExecutionPipeline` is not exported from the public SDK API.
- **Validation**: Run test suite after removal; `ConcurrencyScheduler.test.ts` and `FileLockManager.test.ts` cover concurrency semantics.

---

### Priority 5 — Lower Confidence / Defensive

#### F15. PersistentStore: Full-file-read on every write [S5]

- **Confidence**: high
- **Evidence**:
  - [PersistentStore.ts:100-124](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L100-L124) — `ensureSessionCreated` is called from 5 write methods ([L163](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L163), [L190](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L190), [L233](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L233), [L321](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L321), [L396](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/PersistentStore.ts#L396)).
  - It calls `JSONLStore.getStats()` at [JSONLStore.ts:181](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/context/storage/JSONLStore.ts#L181) which reads the entire file and splits all lines — O(n) I/O repeated on every append.
- **Proposed representation**: Add `private readonly knownSessions = new Set<string>()` to PersistentStore. Hot path: Set lookup. Cold path: `fs.access` syscall (O(1)). Update `deleteSession` to clear from Set.
- **Scope**: 1 file (~10 lines).
- **Edge case**: External process deleting the file between checks — `fs.appendFile` creates the file if missing, same as current behavior.

#### F16. ExecutionPipeline: Derived confirmation fields [S3]

- **Confidence**: medium
- **Evidence**:
  - `PipelineExecutionState.confirmationReason` (derived cache) and `toolRequestedConfirmation` are always recomputable from `confirmationReasons` array via `combineConfirmationReasons` and `reasons.some(r => r.source === 'tool')`.
  - `addConfirmationReason` recomputes `confirmationReason` on each push, but `toolRequestedConfirmation` is set alongside a `'tool'` source push and can become stale if reasons are cleared without resetting the flag (the reset at L776-778 happens to also set `needsConfirmation = false`, so the bug isn't observable today).
- **Proposed representation**: Remove both fields; add two inline helpers for the derived queries.
- **Scope**: `ExecutionPipeline.ts` only (~10 lines).

#### F17. AgentSession: Named transition methods [S7]

- **Confidence**: medium
- **Evidence**:
  - `AgentSessionStore.updateSession(id, Partial<AgentSession>)` allows any field combination.
  - [BackgroundAgentManager.ts:516](file:///Users/bytedance/Documents/GitHub/blade-agent-sdk/src/agent/subagents/BackgroundAgentManager.ts#L516) sets `status: 'cancelled'` without `result`, `completedAt`, or clearing `progress`.
- **Proposed representation**: Add `markCompleted`, `markFailed`, `markCancelled`, `updateRunningSession` methods; each enforces required fields and clears stale state (e.g., `progress` on terminal transition).
- **Scope**: `AgentSessionStore.ts`, `BackgroundAgentManager.ts`.
- **Regression risks**: Making `updateSession` private is internal-only (only BackgroundAgentManager calls it directly).

---

## 3. Cross-Cutting Patterns

| Pattern | Findings | Theme |
|---------|----------|-------|
| Scattered booleans → discriminated union | F2, F3, F4, F5, F6, F7 | Invalid state combinations are the most prevalent structural weakness |
| Duplicated logic → extract helper | F8, F9, F10, F11, F12, F13 | Correctness invariants expressed multiple times |
| Dead code / stale state | F14, F3 (dead mirror) | Batch execution path superseded by agent-loop-level concurrency |
| Dual-write state management | F1, F6 (MCP events vs imperative) | Event handlers and imperative code both mutate shared state |

---

## 4. Explicit Skips

| Subsystem | Reason |
|-----------|--------|
| S12 Memory | Clean interface; `MemoryManager` is thin orchestration over well-defined `MemoryStore`; minimal types; no scattered booleans |
| S13 Runtime | Near-identical merge helpers differ in generic typing intentionally (`Record<string,string>` vs `JsonObject`); `RuntimeContextPatch.reset?` + `context?` used sequentially by design |
| S14 Skills | `SkillParseResult { success, content?, error? }` pattern is conventional, single producer with two consumers that both use `result.success && result.content`, internal-only |
| S15 Types & Constants | Small, focused; permission handlers are already composable |
| S16 Errors | Clean class hierarchy with appropriate base class; no structural issues |
| S17 Utils | Pure functions; no duplicated branching; `pathSecurity` is well-encapsulated |
| S18 Observability | `TraceSpan` lifecycle is correctly managed by single writer (`TraceRecorder`); in-place mutation simpler than object replacement |
| S19 Lifecycle | Single-class registry; trivial state |
| S20 Logging | Two-module-level booleans for three implicit states; transitions trivial |
| S21 Platform Entries | Re-export barrels with no implementation code |
| S22 Scripts/Tooling | Build tooling outside SDK runtime; 600 LoC total, conventional Node scripts |

---

## 5. Recommended Implementation Slices

Each slice is an independently shippable change. Slices within a tier have no cross-dependencies.

| Slice | Tier | Effort | Risk | Notes |
|-------|------|--------|------|-------|
| **F1** — MCP lastError bug fix | P1 bug fix | 15 lines | Minimal | Start here; concrete user-visible bug |
| **F14** — Remove dead batch code | P4 dead code | 90 lines removed | Minimal | Pure deletion; reduces confusion |
| **F12** — DeepSeek token helper | P3 dedup | 8 lines | None | Pure refactor |
| **F11** — `chat()` delegation | P3 dedup | 10 lines | None | Eliminates config drift risk |
| **F8** — Compaction helper | P3 dedup | 15 lines | None | Pure extraction |
| **F13** — OutputParser helper | P3 dedup | 12 lines | None | Pairs well with F4 |
| **F4** — HookExecutionResult union | P2 union | 40 lines | Low (internal) | Do after F13 |
| **F15** — PersistentStore cache | P5 perf | 10 lines | Low | O(n)→O(1) on hot path |
| **F3** — AgentLoop recovery union | P2 union | 50 lines net | Low | Removes ~30 lines of dead state |
| **F5** — SearchProvider union | P2 union | 20 lines | Low (internal) | Internal to web tools |
| **F10** — Write-guard helper | P3 dedup | 50 lines new file | Low | Mechanical extraction |
| **F9** — Subagent creation helper | P3 dedup | 40 lines | Low | Fixes systemPrompt inconsistency |
| **F2** — Session RequestPhase | P2 union + race fix | 30 lines | Medium | Changes concurrency semantics |
| **F7** — Attachment union | P2 union | 30 lines | Low | Consumer is within codebase |
| **F6** — SandboxCheckResult | P2 union | 25 lines | **Public API break** | Semver major; TypeScript catches all breaks |
| **F16** — Confirmation derived fields | P5 defensive | 10 lines | None | Localized |
| **F17** — AgentSession transitions | P5 defensive | 40 lines | Low | Internal API change |

---

## 6. Audit Log

| Step | Action |
|------|--------|
| 1 | Explored repository structure (47k LoC production TS; 22 identifiable subsystems) |
| 2 | Read architectural files: `index.ts`, `Session.ts`, `AgentLoop.ts`, `TurnState.ts`, `HookTypes.ts`, `McpClient.ts`, `ExecutionPipeline.ts`, `ConversationState.ts`, `PersistentStore.ts`, `JSONLStore.ts`, `CompactionService.ts`, `SubagentExecutor.ts`, `BackgroundAgentManager.ts`, `searchProviders.ts`, `SandboxService.ts`, `AttachmentCollector` types, `VercelAIChatService.ts`, `deepseek.ts`, `edit.ts`, `write.ts`, `webSearch.ts`, `McpRegistry.ts`, `HookRuntime.ts`, `ConcurrencyScheduler.ts`, `runToolCall.ts`, `executeToolCalls.ts` |
| 3 | Dispatched 11 parallel review agents with non-overlapping ownership boundaries (bounded concurrency = 5→6 concurrent workers) |
| 4 | Independently validated each finding via direct file reads and grep verification (dead code confirmed by searching for production callers; stale-error bug confirmed by tracing event flow; all duplications confirmed via side-by-side reads) |
| 5 | Ran coverage pass: enumerated all `src/` directories; verified platform entries (`browser/`, `local/`, `server/`, `core/`) are re-export barrels; scripts evaluated as build tooling |
| 6 | Deduplicated findings: F3 combines scattered-bool cleanup with dead-mirror-state removal (one concern: recovery state representation) |
| 7 | Rejected weak abstractions: considered but skipped ToolResult builder pattern, ChatContext/ToolContext unification, TraceSpan discriminated union, serial/mixed/parallel dispatch sharing, ConcurrencyScheduler singleton removal |
| 8 | Ranked all 17 accepted findings by impact → confidence → effort → blast radius; identified dependency-free first slices |

---

## 7. Summary Statistics

| Metric | Value |
|--------|-------|
| Subsystems audited | 22 |
| Subsystems with recommendations | 11 |
| Subsystems explicitly skipped | 11 |
| Total findings | 17 |
| Bug fixes | 1 (F1) |
| Concurrency race fixes | 1 (F2) |
| Discriminated union opportunities | 6 (F2, F3, F4, F5, F6, F7) |
| Duplication extractions | 6 (F8, F9, F10, F11, F12, F13) |
| Dead code removals | 1 (F14) |
| Performance improvements | 1 (F15) |
| Defensive hardening | 2 (F16, F17) |
| Breaking changes | 1 (F6 — public `SandboxCheckResult` reshape) |
| Repository modified during audit | **No** |
