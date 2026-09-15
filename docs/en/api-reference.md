# API Reference

This page inventories the public package surface. The root entry exposes the
default `createAgent()` facade. Lower-level Session APIs live under
`/advanced`, browser contracts under `/browser`, and deployment runtime
components under `/server/infra`.

`/server/infra` targets Node.js server processes, not edge runtimes.
PostgreSQL, OpenTelemetry, non-bundled provider adapters, and native Node
enhancements are optional peers. PostgreSQL and OTel use dedicated adapter
subpaths so canonical entrypoints do not load absent peers. Some packages can
still be present transitively through base dependencies.

The package also ships the `create-blade-agent` executable. Its
`--preset <local|web|production>` option selects the generated project
topology, while `--verify` enables post-installation verification. Omitting
`--preset` generates the default `local` starter. It is an npm binary, not a
JavaScript package export.

## Entry points

| Entry | Runtime | Contents |
|-------|---------|----------|
| `@blade-ai/agent-sdk` | Node.js | Default `createAgent`, tool authoring, and public type entry |
| `@blade-ai/agent-sdk/browser` | Browser and Node.js | `AgentClient`, protocol schemas, parsers, events, and constants |
| `@blade-ai/agent-sdk/server/infra` | Node.js server | `AgentServer`, Workers, Runtime Store contracts, and conformance suites |
| `@blade-ai/agent-sdk/advanced` | Node.js | Local/server Sessions, `SessionRunner`, execution hosts, and Node adapters |

The former `/node`, `/server`, `/core`, `/model`, `/session`, `/middleware`,
`/tools`, `/protocol`, and `/server/testing` paths are deprecated compatibility
aliases. Optional PostgreSQL and OTel adapters retain `/server/postgres` and
`/server/otel` so canonical imports do not force-load peer dependencies.
The package is ESM-only. Browser calls to server-only APIs resolve to explicit
stubs.

## Agent

Runtime:

- `createAgent`
- `AgentResponse`

Types:

`Agent`, `AgentOptions`, `AgentAdvancedOptions`, `AgentProfile`,
`AgentFilesystemOptions`, `AgentPermission`, `AgentPermissionPreset`,
`AgentPermissionRequest`, `AgentPermissionDecision`, `AgentResponseEvent`,
`AgentResponseEventType`, `AgentResponseListener`, `AgentResponseSubmission`,
`InlineHooks`, `SessionHookEvent`, `UserMessageContent`, `SkillActivationContext`,
`SkillDefinition`, `SkillMetadata`, and `SkillRegistryConfig`.

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
- `JsonlSessionRepository` (`/advanced`)
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
- `assertRuntimeStoreConformance` (`/server/infra`)

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
- `DockerExecutionHost` (`/advanced`)
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
- `DockerExecutionHostOptions` (`/advanced`)

## Durable Events

Runtime:

- `DurableExecutionLease`
- `DurableExecutionLeaseError`
- `executionFence`
- `isDurableExecutionLeaseStore`
- `DURABLE_EXECUTION_LEASE_FORMAT`
- `JsonlDurableEventStore` (`/advanced`)
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
- `JsonlDurableEventStoreOptions` (`/advanced`)
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

The JSONL adapter is Node-only and exported from `/advanced`. Event contracts,
constants, errors, and parsers are browser-safe through `/browser`.

## Tools

Authoring and execution:

| Export | Purpose |
|--------|---------|
| `defineTool` | Define an async-function or generator tool with TypeBox |
| `createTool` | Create a TypeBox-backed runtime tool |
| `toolFromDefinition` | Convert a definition to `Tool` |
| `collectToolExecution` | Drain a generator and return its terminal result |
| `completeToolExecution` | Wrap a terminal result in a generator |
| `getBuiltinTools` | Build the `/advanced` local tool set |
| `createMemoryReadTool` | Create an opt-in memory reader (`/advanced`) |
| `createMemoryWriteTool` | Create an opt-in memory writer (`/advanced`) |

Types:

`ConfirmationDetails`, `ConfirmationHandler`, `ConfirmationResponse`,
`FunctionDeclaration`, `Tool`,
`ToolBehavior`, `ToolConfig`, `ToolDefinition`,
`ToolDefinitionInput`, `ToolDescription`,
`ToolDescriptionResolver`, `ToolDisplayContent`, `ToolEffect`,
`ToolEffectYield`, `ToolError`, `ToolExecution`, `ToolExecutionLifecycle`,
`ToolExecutionStartedLifecycle`, `ToolInvocationLifecycle`,
`ToolScheduledLifecycle`, `ToolSettledLifecycle`,
`ToolPermissionResolution`, `ToolExposureConfig`, `ToolExposureMode`,
`ToolMessage`, `ToolModelContent`, `ToolProgress`, `ToolSchema`, `ToolSideEffect`,
`RuntimeAccess`, `DiscoverableCatalogView`, `DiscoverableToolInfo`,
`ToolServiceMap`, `ToolServiceName`,
`ToolExecutionUpdate`, and `ToolYield`.

Constants:

- `ToolKind`: `ReadOnly`, `Write`, and `Execute`
- `ToolSideEffect`: `PURE`, `IDEMPOTENT`, and `NON_IDEMPOTENT`
- `ToolErrorType`: validation, permission, execution, interruption, timeout, and network errors

`ToolConfig` requires a `sideEffect` declaration. `ToolDefinition` defaults to
`non_idempotent` when it is omitted. The resolved value determines whether a
started tool can be replayed during durable recovery.

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
- `WebFetchSecurityPolicy`

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

There is no `@blade-ai/agent-sdk/mcp` entry point. Import these exports from `/advanced`.

## Memory

Runtime:

- `FileSystemMemoryStore` (`/advanced`)
- `MemoryManager` (`/advanced`)

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
- `ConversationMessage`
- `ConversationMessageSource`
- `CONVERSATION_MESSAGE_SOURCES`
- `isConversationMessageSource`
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
- `ModelMessageProviderOptions`
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

`HookEvent` has 22 shell-hook protocol events.
`AgentOptions.advanced.hooks` and `SessionOptions.hooks` only accept the eight
events in `SessionHookEvent`; see [Hooks](./hooks).

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

- `AgentSessionRepository` — storage capability for subagent Sessions; inject a
  repository-backed implementation so subagent state can survive a move between
  hosts instead of only a restart on the same one
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
