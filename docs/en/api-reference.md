# API Reference

This page inventories the public package surface. Detailed behavior is documented on the feature pages.

`/server` currently targets Node.js server processes, not edge runtimes.
PostgreSQL, OpenTelemetry, non-bundled provider adapters, and native Node
enhancements are optional peers, and `/server` no longer statically loads their adapters.
Some packages can still be present transitively through base dependencies.

The package also ships the `create-blade-agent` executable. Its
`--preset <local|web|production>` option generates and verifies a standalone
topology; omitting `--preset` preserves the production default. It is an npm
binary, not a JavaScript package export.

## Entry points

| Entry | Runtime | Contents |
|-------|---------|----------|
| `@blade-ai/agent-sdk` | Node.js server | Server-first Session API; only explicit tools, agents, middleware, and MCP servers are loaded |
| `@blade-ai/agent-sdk/server` | Node.js server | Server entry without implicit local host access, equivalent to root |
| `@blade-ai/agent-sdk/server/postgres` | Node.js server | PostgreSQL Runtime Store adapter |
| `@blade-ai/agent-sdk/server/otel` | Node.js server | OpenTelemetry metrics, traces, and audit adapter |
| `@blade-ai/agent-sdk/server/testing` | Node.js test | Runtime Store conformance suite |
| `@blade-ai/agent-sdk/node` | Local Node.js process | Entry with local tools, workspace discovery, and Node host adapters enabled |
| `@blade-ai/agent-sdk/session` | Node.js server | Lower-level Session functions and types using the server profile |
| `@blade-ai/agent-sdk/core` | Browser and Node.js | Browser-safe contracts, constants, and types |
| `@blade-ai/agent-sdk/browser` | Browser | `AgentClient`, protocol types, core contracts, and stubs for server-only functions |
| `@blade-ai/agent-sdk/protocol` | Browser and Node.js | Versioned command/event schemas, parsers, and protocol errors |
| `@blade-ai/agent-sdk/tools` | Browser and Node.js | Tool authoring, catalog, and execution contracts |
| `@blade-ai/agent-sdk/middleware` | Browser and Node.js | Onion composition, model/tool middleware, and plugin definitions |
| `@blade-ai/agent-sdk/model` | Browser and Node.js | Provider-neutral model configuration, messages, services, retries, and usage |

The package is ESM-only. Browser imports of root, `/server`, `/session`, or `/node` resolve server APIs to stubs that throw an explicit error.

## Session

Functions:

| Export | Purpose |
|--------|---------|
| `createSession` | Create a Session |
| `resumeSession` | Restore persisted state |
| `forkSession` | Fork persisted state |
| `prompt` | Run a one-shot request |

Types:

`AgentDefinition`, `BuiltinProviderType`, `ModelServiceConfig`, `ExecutionContext`,
`ForkOptions`, `ForkSessionOptions`,
`ForkSessionResult`, `HookCallback`, `HookInput`, `HookOutput`,
`InputSubmission`, `ISession`, `McpServerStatus`, `McpToolInfo`, `ModelIdentity`, `ModelInfo`,
`PendingSessionInput`, `PromptResult`, `ProviderAdapter`, `ProviderConnectionConfig`,
`ProviderRegistryErrorCode`, `ProviderType`,
`ResumeOptions`, `SendOptions`, `SessionHandoffErrorCode`,
`SessionHandoffResult`, `SessionOptions`, `SessionRepository`,
`SessionEventStore`, `SessionPersistence`, `SessionTool`, `SessionStreamEvent`,
`StreamOptions`, `SubagentInfo`, `TokenUsage`, `ToolExecutionRecord`,
`ToolDefinition`, and `ToolResult`.

Repository support types:

`SessionRepositoryMessageMetadata`, `SessionRepositoryCompactionMetadata`,
`SessionRepositorySubagentInfo`, `SessionRepositorySubagentRef`,
`SessionRepositoryHealth`, and `SessionRepositoryStorageStats`.

Errors:

- `SessionHandoffError`

Constants:

- `InputPriority`
- `InputId`
- `RequestId`
- `SessionId`
- `EventId`
- `EventSequence`
- `CommandId`
- `TurnId`
- `ModelAttemptId`
- `ToolAttemptId`
- `PermissionRequestId`
- `WorkerId`
- `ExecutionLeaseId`
- `FencingToken`
- `AgentId`
- `MessageId`
- `PartId`
- `ToolUseId`
- `TraceId`
- `SpanId`
- `TraceEventId`

These ID exports are branded identifiers, not arbitrary strings.

## Server Runtime

Runtime:

- `AgentServer`
- `InProcessSessionExecutor`
- `SdkSessionRunner`
- `ExecutionHostSessionRunner`
- `AgentWorker`
- `AgentRuntimeOperations`
- `EffectDispatcher`
- `AgentClient`
- `RemoteAgentSession`
- `InMemoryAgentServerStore`
- `RuntimeStoreError`
- `TenantAdmissionController`
- `JsonlSessionRepository` (`/node` only)
- `AgentProtocolError`
- `AGENT_PROTOCOL_VERSION`
- `AgentCommandType`
- `parseAgentCommand`
- `parseAgentCommandResult`
- `parseAgentEventCursor`
- `parseAgentServerEvent`
- `agentInitializationDataSchema`

Types:

- `AgentServerOptions`
- `AgentServerSessionContext`
- `SessionExecutor`
- `SessionExecutorCommandContext`
- `SessionExecutorEventPublisher`
- `SessionExecutorReadResult`
- `InProcessSessionExecutorOptions`
- `AgentServerStore`
- `RuntimeStore`
- `RuntimeTenantStore`
- `RUNTIME_STORE_SCHEMA_VERSION`
- `RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION`
- `RuntimeCommandCommit`
- `RuntimeCommitResult`
- `RuntimeDomainEvent`
- `RuntimeDomainEventDraft`
- `RuntimeDomainEventPage`
- `RuntimeEffectIntent`
- `RuntimeEffectRecord`
- `RuntimeEffectStatus`
- `RuntimeWorkerRecord`
- `RuntimeWorkerRegistration`
- `RuntimeSessionRoute`
- `RuntimeSessionClaim`
- `RuntimeSessionState`
- `RuntimeEffectClaim`
- `RuntimeEffectLease`
- `RuntimeEffectExecutionMode`
- `RuntimeEffectReconciliation`
- `RuntimeQueueMetrics`
- `RuntimeEffectHandler`
- `RuntimeEffectHandlerContext`
- `RetryableRuntimeEffectError`
- `UncertainRuntimeEffectError`
- `SessionRunner`
- `SessionRunnerContext`
- `SessionRunResult`
- `WorkerRuntimeStore`
- `WorkerRuntimeError`
- `RuntimeProjectionCheckpoint`
- `RuntimeProjectionRecord`
- `AgentCommandClaim`
- `AgentServerSessionRecord`
- `AgentServerTelemetry`
- `AgentServerAuditRecord`
- `AgentClientOptions`
- `AgentClientCommandOptions`
- `AgentClientEventOptions`
- `AgentCommand`
- `AgentCommandResult`
- `AgentServerEvent`
- `AgentEventCursor`
- `AgentEventPage`
- `AgentPrincipal`
- `AgentServerScope`
- `AgentProtocolCapabilities`
- `AgentInitializationData`
- `AgentClientCapabilities`
- `AgentProtocolErrorCode`
- `assertRuntimeStoreConformance` (`/server/testing`)

`PostgresRuntimeStore` is exported by `/server/postgres`.
`OpenTelemetryAgentServerTelemetry` and
`OpenTelemetryAgentWorkerTelemetry` are exported by `/server/otel`.

See [Server Runtime](./server-runtime), [Runtime Store](./runtime-store),
[Worker Runtime](./worker-runtime), and
[Execution Host](./execution-host) for deployment and failure semantics.

## Execution Host

Runtime:

- `EphemeralCredentialBroker`
- `ExecutionHostError`
- `DockerExecutionHost` (`/node` only)
- `ExecutionId`
- `ExecutionCheckpointId`
- `CredentialLeaseId`

Types:

- `ExecutionHost`
- `ExecutionProvisionRequest`
- `ExecutionHandle`
- `ExecutionExecRequest`
- `ExecutionExecResult`
- `ExecutionCheckpoint`
- `ExecutionRestoreRequest`
- `ExecutionResourceLimits`
- `ExecutionNetworkPolicy`
- `ExecutionWorkspaceSource`
- `ExecutionEgressController`
- `ExecutionEgressLease`
- `CredentialBroker`
- `CredentialIssuer`
- `CredentialRequest`
- `CredentialLease`
- `CredentialIssueContext`
- `IssuedCredential`
- `ExecutionHostErrorCode`
- `DockerExecutionHostOptions` (`/node` only)

## Durable Events

Runtime:

- `DurableExecutionLease`
- `DurableExecutionLeaseError`
- `executionFence`
- `isDurableExecutionLeaseStore`
- `DURABLE_EXECUTION_LEASE_FORMAT`
- `JsonlDurableEventStore` (`/node` only)
- `DurableEventSubscription`
- `durableEventCursor`
- `parseDurableEventCursor`
- `DURABLE_EVENT_CURSOR_VERSION`
- `DurableSessionJournal`
- `DurableSessionRecoveryCoordinator`
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

- `DurableExecutionLeaseOptions`
- `DurableExecutionLeaseStore`
- `DurableExecutionLeaseSnapshot`
- `DurableExecutionFence`
- `DurableExecutionLeaseErrorCode`
- `DurableEventStore`
- `JsonlDurableEventStoreOptions` (`/node` only)
- `DurableEventCursor`
- `DurableEventSubscriptionOptions`
- `DurableEventSubscriptionMessage`
- `DurableEventSubscriptionError`
- `DurableEventSubscriptionErrorCode`
- `DurableSessionJournalOptions`
- `DurableSessionCommand`
- `DurableCommandEventDraft`
- `DurableCommandCommitOptions`
- `DurableCommandCommitResult`
- `DurableCommandCommitStatus`
- `DurableSessionJournalError`
- `DurableSessionJournalErrorCode`
- `DurableSessionRecoveryError`
- `DurableSessionRecoveryErrorCode`
- `DurableCommandConflictError`
- `DurableCommandOutcomeUnknownError`
- `DurableEventEnvelope`
- `DurableEventDraft`
- `DurableEventDataMap`
- `DurableEventError`
- `DurableEventSchemaVersion`
- `DurableEventOfType`
- `DurableModelResponse`
- `DurableModelToolCall`
- `DurableModelUsage`
- `DurableTokenUsage`
- `DurableInputPriority`
- `DurablePermissionDecision`
- `DurableRequestInterruptReason`
- `DurableRequestRecoveryOrigin`
- `DurableModelRequestAbortReason`
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
- `DurableRequestRolloverCommand`
- `DurableRequestRolloverResult`
- `DurableRequestOutcomeReconciliation`
- `DurableRequestOutcomeReconciliationCommand`
- `DurableModelOutcomeReconciliation`
- `DurableModelOutcomeReconciliationCommand`
- `DurableRequestRecoveryKind`
- `DurableTurnRecoveryCommand`
- `DurableTurnRecoveryResult`
- `SessionDurableRecorderError`
- `DurablePermissionProjection`
- `DurablePermissionStatus`
- `DurableRequestProjection`
- `DurableRequestStatus`
- `DurableSessionProjection`
- `DurableSessionProjectionStatus`
- `DurableSessionRecoveryAction`
- `DurableSessionRecoveryPlan`
- `DurableAcceptedRequestRecovery`
- `DurableSessionResumeDecision`
- `DurableToolOutcomeReconciliation`
- `DurableToolOutcomeReconciliationCommand`
- `DurableToolStartCommand`
- `DurablePermissionResolutionCommand`
- `DurableRecoveryCommitResult`
- `DurableToolAttemptProjection`
- `DurableToolAttemptStatus`
- `DurableModelAttemptProjection`
- `DurableModelAttemptStatus`
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
| `getBuiltinTools` | Build the `/node` local tool set |
| `createMemoryReadTool` | Create an opt-in memory reader (`/node`) |
| `createMemoryWriteTool` | Create an opt-in memory writer (`/node`) |

Types:

`ConfirmationDetails`, `ConfirmationHandler`, `ConfirmationResponse`,
`FunctionDeclaration`, `Tool`, `ToolBehavior`, `ToolConfig`, `ToolDescription`,
`ToolDescriptionResolver`, `ToolDisplayContent`, `ToolEffect`,
`ToolEffectYield`, `ToolError`, `ToolExecution`, `ToolExecutionLifecycle`,
`ToolExecutionStartedLifecycle`, `ToolInvocationLifecycle`,
`ToolScheduledLifecycle`, `ToolSettledLifecycle`,
`ToolPermissionResolution`, `ToolExposureConfig`, `ToolExposureMode`,
`ToolMessage`, `ToolModelContent`, `ToolProgress`, `ToolSchema`, `ToolSideEffect`,
`ToolExecutionUpdate`, and `ToolYield`.

Constants:

- `ToolKind`: `ReadOnly`, `Write`, and `Execute`
- `ToolSideEffect`: `PURE`, `IDEMPOTENT`, and `NON_IDEMPOTENT`
- `ToolErrorType`: validation, permission, execution, interruption, timeout, and network errors

Every `ToolDefinition` and `ToolConfig` requires a `sideEffect` declaration.
The resolved value determines whether a started tool can be replayed during
durable recovery.

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

There is no `@blade-ai/agent-sdk/mcp` entry point. Import these exports from `/node`.

## Memory

Runtime:

- `FileSystemMemoryStore` (`/node`)
- `MemoryManager` (`/node`)

Types:

- `Memory`
- `MemoryInput`
- `MemoryStore`
- `MemoryType`

Memory tools are opt-in.

`createMemoryReadTool()` and `createMemoryWriteTool()` return complete `Tool`
instances that can be passed directly to `SessionOptions.tools`.

## Providers

Runtime:

- `ProviderRegistry`
- `ProviderRegistryError`

Types:

- `BuiltinProviderType`
- `ProviderType`
- `PROVIDER_TYPES`
- `isBuiltinProviderType`
- `ProviderConnectionConfig`
- `ProviderAdapter`
- `ProviderRegistryErrorCode`
- `ModelConfig`
- `ModelServiceConfig`
- `ModelService`
- `ModelMessage`
- `ModelContent`
- `ModelTextContent`
- `ModelImageContent`
- `ModelToolCall`
- `ModelToolCallDelta`
- `ModelStreamToolCall`
- `ModelResponse`
- `ModelStreamChunk`
- `ModelToolDefinition`
- `ModelProviderOptions`
- `ModelSideQueryOptions`
- `ModelRetryConfig`
- `ModelRetryEvent`
- `QuerySource`
- `ModelIdentity`
- `ModelUsage`
- `TokenUsage`
- `resolveModelIdentity`
- `normalizeModelUsage`

See [Providers and Logging](./providers) for adapter registration and routing
semantics, and [Type Architecture](./type-architecture) for ownership and
boundary rules.

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
- `ConfirmationDetails` (`abortSignal` is the active Request signal)
- `ConfirmationHandler`
- `ConfirmationResponse`
- `PermissionHandler`
- `PermissionHandlerRequest`
- `PermissionResult`
- `PermissionRuleValue`
- `PermissionsConfig`
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

## Middleware and plugins

Runtime:

- `composeMiddleware`
- `definePlugin`
- `wrapModelService`

Types:

- `Middleware` / `MiddlewareNext`
- `AgentMiddlewareConfig`
- `AgentPlugin`
- `ModelMiddleware`
- `ModelChatRequest` / `ModelSideQueryRequest`
- `ModelStreamRequest` / `ModelRetryRequest`
- `ToolMiddleware` / `ToolMiddlewareRequest`

See [Middleware and plugins](./middleware).

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
- `HookTimeoutError`
- `ModelTimeoutError`
- `PermissionDeniedError`
- `ProviderRegistryError`
- `SessionInputError`
- `ToolExecutionError`

Types and helpers:

- `SdkErrorOptions`
- `HookTimeoutErrorCode`
- `ModelTimeoutErrorCode`
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

Constants:

- `MessageRole`
- `SessionStreamEventType`

Utility:

- `lazySingleton`
