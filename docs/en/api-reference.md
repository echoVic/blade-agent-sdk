# API Reference

This page inventories the public package surface. Detailed behavior is documented on the feature pages.

## Entry points

| Entry | Runtime | Contents |
|-------|---------|----------|
| `@blade-ai/agent-sdk` | Node.js | Complete Session-first API |
| `@blade-ai/agent-sdk/server` | Node.js | Explicit server facade equivalent to root |
| `@blade-ai/agent-sdk/session` | Node.js | Session functions and types |
| `@blade-ai/agent-sdk/core` | Browser and Node.js | Browser-safe contracts, constants, and types |
| `@blade-ai/agent-sdk/browser` | Browser | Core contracts plus stubs for server-only functions |
| `@blade-ai/agent-sdk/tools` | Browser and Node.js | Tool authoring, catalog, and execution contracts |
| `@blade-ai/agent-sdk/local` | Node.js | Built-in tools, MCP, memory, and sandbox adapters |

The package is ESM-only. Browser imports of root, `/server`, `/session`, or `/local` resolve server APIs to stubs that throw an explicit error.

## Session

Functions:

| Export | Purpose |
|--------|---------|
| `createSession` | Create a Session |
| `resumeSession` | Restore persisted state |
| `forkSession` | Fork persisted state |
| `prompt` | Run a one-shot request |

Types:

`AgentDefinition`, `ExecutionContext`, `ForkOptions`, `ForkSessionOptions`,
`ForkSessionResult`, `HookCallback`, `HookInput`, `HookOutput`,
`InputSubmission`, `ISession`, `McpServerStatus`, `McpToolInfo`, `ModelInfo`,
`PendingSessionInput`, `PromptResult`, `ProviderConfig`, `ProviderType`,
`ResumeOptions`, `SendOptions`, `SessionOptions`, `SessionTool`, `StreamMessage`,
`StreamOptions`, `SubagentInfo`, `TokenUsage`, `ToolCallRecord`,
`ToolDefinition`, and `ToolResult`.

Constants:

- `InputPriority`
- `InputId`
- `RequestId`
- `SessionId`
- `EventId`
- `EventSequence`
- `CommandId`
- `TurnId`
- `ToolAttemptId`
- `PermissionRequestId`
- `AgentId`
- `MessageId`
- `ToolUseId`

These ID exports are branded identifiers, not arbitrary strings.

## Durable Events

Runtime:

- `JsonlDurableEventStore`
- `DurableSessionJournal`
- `DurableEventType`
- `DURABLE_EVENT_SCHEMA_VERSION`
- `DURABLE_EVENT_LOG_FORMAT`
- `parseDurableEventDraft`
- `parseDurableEventEnvelope`
- `parsePersistedDurableEventBatch`
- `isDurableEventType`
- `projectDurableSession`
- `planDurableSessionRecovery`
- `DurableSessionProjector`

Types and errors:

- `DurableEventStore`
- `DurableSessionJournalOptions`
- `DurableSessionCommand`
- `DurableCommandEventDraft`
- `DurableCommandCommitResult`
- `DurableCommandCommitStatus`
- `DurableSessionJournalError`
- `DurableSessionJournalErrorCode`
- `DurableCommandConflictError`
- `DurableCommandOutcomeUnknownError`
- `DurableEventEnvelope`
- `DurableEventDraft`
- `DurableEventDataMap`
- `DurableEventError`
- `DurableEventOfType`
- `DurableTokenUsage`
- `DurableInputPriority`
- `DurablePermissionDecision`
- `DurableRequestInterruptReason`
- `DurableTurnAbortReason`
- `DurableToolInterruptBehavior`
- `DurableToolCancelReason`
- `DurableToolOutcomeUnknownReason`
- `DurableSessionCloseReason`
- `DurableEventAppendOptions`
- `DurableEventAppendResult`
- `DurableEventReadOptions`
- `DurableEventPage`
- `PersistedDurableEventBatch`
- `DurableEventSequenceConflictError`
- `DurableEventStoreError`
- `DurableEventStoreErrorCode`
- `DurableEventProjectionError`
- `DurableSessionRecoveryRequiredError`
- `SessionDurableRecorderError`
- `DurablePermissionProjection`
- `DurablePermissionStatus`
- `DurableRequestProjection`
- `DurableRequestStatus`
- `DurableSessionProjection`
- `DurableSessionProjectionStatus`
- `DurableSessionRecoveryAction`
- `DurableSessionRecoveryPlan`
- `DurableToolAttemptProjection`
- `DurableToolAttemptStatus`
- `DurableTurnProjection`
- `DurableTurnStatus`

The JSONL adapter is Node-only. Event contracts, constants, errors, and parsers
are browser-safe through `/core`.

## Tools

Authoring and execution:

| Export | Purpose |
|--------|---------|
| `defineTool` | Define a JSON Schema tool |
| `createTool` | Create a Zod-backed tool |
| `toolFromDefinition` | Convert a definition to `Tool` |
| `collectToolExecution` | Drain a generator and return its terminal result |
| `completeToolExecution` | Wrap a terminal result in a generator |
| `getBuiltinTools` | Build the Node-local built-in tool set |
| `createMemoryReadTool` | Create an opt-in memory reader |
| `createMemoryWriteTool` | Create an opt-in memory writer |

Types:

`FunctionDeclaration`, `Tool`, `ToolBehavior`, `ToolConfig`, `ToolDescription`,
`ToolDescriptionResolver`, `ToolDisplayContent`, `ToolEffect`,
`ToolEffectYield`, `ToolError`, `ToolExecution`, `ToolExecutionLifecycle`,
`ToolInvocationLifecycle`, `ToolScheduledLifecycle`, `ToolSettledLifecycle`,
`ToolPermissionResolution`, `ToolExposureConfig`, `ToolExposureMode`,
`ToolMessage`, `ToolModelContent`, `ToolProgress`, `ToolSchema`,
`ToolExecutionUpdate`, and `ToolYield`.

Constants:

- `ToolKind`: `ReadOnly`, `Write`, and `Execute`
- `ToolErrorType`: validation, permission, execution, interruption, timeout, and network errors

## Tool catalog

Runtime:

- `ToolCatalog`

Types:

- `ToolCatalogEntry`
- `ToolCatalogReadView`
- `ToolCatalogSourcePolicy`
- `ToolSourceInfo`
- `ToolSourceKind`
- `ToolTrustLevel`

Source kinds are `builtin`, `custom`, `mcp`, and `session`. Trust levels are `trusted`, `workspace`, and `remote`.

## MCP

Runtime:

- `createSdkMcpServer`
- `tool`

Types:

- `McpServerConfig`
- `McpToolCallResponse`
- `McpToolDefinition`
- `McpToolResponse`
- `SdkMcpServerHandle`
- `SdkTool`

There is no `@blade-ai/agent-sdk/mcp` entry point. Import these exports from root or `/local`.

## Memory

Runtime:

- `FileSystemMemoryStore`
- `MemoryManager`

Types:

- `Memory`
- `MemoryInput`
- `MemoryStore`
- `MemoryType`

Memory tools are opt-in.

`createMemoryReadTool()` and `createMemoryWriteTool()` return complete `Tool`
instances that can be passed directly to `SessionOptions.tools`.

## Permissions

Helpers:

- `createCompositePermissionHandler`
- `createModePermissionHandler`
- `createPathSafetyPermissionHandler`
- `createPermissionHandlerFromCanUseTool`
- `createRuleBasedPermissionHandler`

Types:

- `CanUseTool`
- `CanUseToolOptions`
- `PermissionHandler`
- `PermissionHandlerRequest`
- `PermissionResult`
- `PermissionRuleValue`
- `PermissionUpdate`

Constants:

- `PermissionMode`
- `PermissionDecision`

## Hooks

Runtime:

- `getHookSchemas`

Types and constants:

- `HookCallback`
- `HookInput`
- `HookOutput`
- `HookEvent`
- `DecisionBehavior`
- `HookExitCode`
- `HookType`

`HookEvent` has 22 protocol events. `SessionOptions.hooks` only accepts the eight events in `SessionHookEvent`; see [Hooks](./hooks).

## Runtime context

Helpers:

- `createContextSnapshot`
- `hasFilesystemCapability`
- `mergeContext`

Types:

- `ContextSnapshot`
- `RuntimeContext`
- `RuntimeContextPatch`
- `RuntimeHookEvent`
- `RuntimeHookRegistration`
- `RuntimeModelOverride`
- `RuntimePatch`
- `RuntimePatchScope`
- `RuntimePatchSkillInfo`
- `RuntimeToolDiscoveryPatch`
- `RuntimeToolPolicyPatch`

## Subagents

Runtime:

- `SubagentExecutor`
- `SubagentRegistry`

Types:

- `SubagentColor`
- `SubagentConfig`
- `SubagentContext`
- `SubagentResult`
- `SubagentSource`

`AgentDefinition`, used by `SessionOptions.agents`, is intentionally smaller than lower-level `SubagentConfig`.

## Observability

Types:

- `AgentTrace`
- `ObservabilityOptions`
- `TraceEvent`
- `TracePayloadSummary`
- `TraceSink`
- `TraceSpan`
- `TraceSpanKind`
- `TraceStatus`

## Token budgets

- `TokenBudgetConfig`
- `TokenBudgetSnapshot`

## DeepSeek helpers

Functions and constants:

- `calculateDeepSeekCost`
- `createDeepSeekBatchChatCompletions`
- `createDeepSeekChatCompletion`
- `createDeepSeekFimCompletion`
- `createDeepSeekLongContextChunks`
- `createDeepSeekLongContextMessages`
- `createDeepSeekLongContextPlan`
- `createDeepSeekTokenBudgetCostConfig`
- `estimateDeepSeekTokens`
- `getDeepSeekPricing`
- `normalizeDeepSeekModel`
- `optimizeDeepSeekCachePrefix`
- `resolveDeepSeekBaseUrl`
- `sanitizeDeepSeekStrictSchema`
- `summarizeDeepSeekBatchChatCompletions`
- `DEEPSEEK_BETA_BASE_URL`
- `DEEPSEEK_DEFAULT_BASE_URL`
- `DEEPSEEK_DEFAULT_MODEL`
- `DEEPSEEK_DEFAULT_PRICING`
- `DeepSeekCostTracker`

Types:

`DeepSeekBatchChatCompletionItem`, `DeepSeekBatchChatCompletionOptions`,
`DeepSeekBatchChatCompletionResult`, `DeepSeekBatchChatCompletionSummary`,
`DeepSeekCacheOptimizationOptions`, `DeepSeekChatCompletionOptions`,
`DeepSeekChatCompletionResponse`, `DeepSeekChatMessage`,
`DeepSeekCostBreakdown`, `DeepSeekCostSnapshot`,
`DeepSeekFimCompletionOptions`, `DeepSeekFimCompletionResponse`,
`DeepSeekLongContextChunk`, `DeepSeekLongContextOptions`,
`DeepSeekLongContextPlan`, `DeepSeekPricing`, and `DeepSeekProviderOptions`.

## Errors

Classes:

- `SdkError`
- `AbortError`
- `ConfigError`
- `PermissionDeniedError`
- `SessionInputError`
- `ToolExecutionError`

Types and helpers:

- `SdkErrorOptions`
- `SessionInputErrorCode`
- `getErrorCode`
- `getErrorMessage`
- `getErrorName`
- `toError`

## Lifecycle

- `registerCleanup`
- `gracefulShutdown`
- `resetCleanupRegistry`
- `CleanupFn`
- `CleanupHandle`
- `GracefulShutdownOptions`

## Common contracts

Types:

- `JsonObject`
- `JsonValue`
- `OutputFormat`
- `SandboxSettings`
- `AgentLogger`
- `LogEntry`
- `LogLevelName`
- `Assert`
- `Extends`
- `IsEqual`
- `KeysEqual`

Constants:

- `MessageRole`
- `StreamMessageType`

Utility:

- `lazySingleton`
