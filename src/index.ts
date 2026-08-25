// Server-first facade. Import /node when the runtime may access local host
// capabilities such as builtin tools, sandboxing, and JSONL stores.

// --- Agent ---
export type { ToolExecutionUpdate } from './agent/loop/runToolCall.js';
export { SubagentExecutor } from './agent/subagents/SubagentExecutor.js';
export { SubagentRegistry } from './agent/subagents/SubagentRegistry.js';
export type {
  SubagentColor,
  SubagentConfig,
  SubagentContext,
  SubagentResult,
  SubagentSource,
} from './agent/subagents/types.js';
export type { TokenBudgetConfig, TokenBudgetSnapshot } from './agent/TokenBudget.js';
export type {
  HookTimeoutErrorCode,
  ModelTimeoutErrorCode,
  ProviderRegistryErrorCode,
  SdkErrorOptions,
  SessionHandoffErrorCode,
  SessionInputErrorCode,
} from './errors/index.js';
// --- Error hierarchy ---
export {
  AbortError,
  ConfigError,
  HookTimeoutError,
  ModelTimeoutError,
  PermissionDeniedError,
  ProviderRegistryError,
  SdkError,
  SessionHandoffError,
  SessionInputError,
  ToolExecutionError,
} from './errors/index.js';
// --- Hook schema accessors ---
export { getHookSchemas } from './hooks/schemas/HookSchemas.js';
// --- Hook system ---
export {
  DecisionBehavior,
  HookExitCode,
  HookType,
} from './hooks/types/HookTypes.js';
export type {
  CleanupFn,
  CleanupHandle,
  GracefulShutdownOptions,
} from './lifecycle/CleanupRegistry.js';
// --- Lifecycle ---
export {
  gracefulShutdown,
  registerCleanup,
  resetCleanupRegistry,
} from './lifecycle/CleanupRegistry.js';
export type {
  McpToolCallResponse,
  McpToolDefinition,
  SdkMcpServerHandle,
  SdkTool,
  ToolResponse as McpToolResponse,
} from './mcp/index.js';
export type { Memory, MemoryInput, MemoryStore, MemoryType } from './memory/index.js';
// --- Middleware and plugins ---
export * from './middleware/index.js';
export { ProviderRegistry } from './services/ProviderRegistry.js';
export type { ProviderAdapter } from './services/ProviderRegistry.js';
// --- Observability ---
export type {
  AgentTrace,
  ObservabilityOptions,
  TraceEvent,
  TracePayloadSummary,
  TraceSink,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from './observability/index.js';
// --- Remote protocol ---
export * from './protocol/index.js';
export type {
  ContextSnapshot,
  RuntimeContext,
  RuntimeContextPatch,
  RuntimeHookEvent,
  RuntimeHookRegistration,
  RuntimeModelOverride,
  RuntimePatch,
  RuntimePatchScope,
  RuntimePatchSkillInfo,
  RuntimeToolDiscoveryPatch,
  RuntimeToolPolicyPatch,
} from './runtime/index.js';
// --- Runtime ---
export {
  createContextSnapshot,
  hasFilesystemCapability,
  mergeContext,
} from './runtime/index.js';
export type {
  DeepSeekBatchChatCompletionItem,
  DeepSeekBatchChatCompletionOptions,
  DeepSeekBatchChatCompletionResult,
  DeepSeekBatchChatCompletionSummary,
  DeepSeekCacheOptimizationOptions,
  DeepSeekChatCompletionOptions,
  DeepSeekChatCompletionResponse,
  DeepSeekChatMessage,
  DeepSeekCostBreakdown,
  DeepSeekCostSnapshot,
  DeepSeekFimCompletionOptions,
  DeepSeekFimCompletionResponse,
  DeepSeekLongContextChunk,
  DeepSeekLongContextOptions,
  DeepSeekLongContextPlan,
  DeepSeekPricing,
  DeepSeekProviderOptions,
} from './services/deepseek.js';
export {
  calculateDeepSeekCost,
  createDeepSeekBatchChatCompletions,
  createDeepSeekChatCompletion,
  createDeepSeekFimCompletion,
  createDeepSeekLongContextChunks,
  createDeepSeekLongContextMessages,
  createDeepSeekLongContextPlan,
  createDeepSeekTokenBudgetCostConfig,
  DEEPSEEK_BETA_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_PRICING,
  DeepSeekCostTracker,
  estimateDeepSeekTokens,
  getDeepSeekPricing,
  normalizeDeepSeekModel,
  optimizeDeepSeekCachePrefix,
  resolveDeepSeekBaseUrl,
  sanitizeDeepSeekStrictSchema,
  summarizeDeepSeekBatchChatCompletions,
} from './services/deepseek.js';
export * from './session/events/core.js';
export type {
  AgentDefinition,
  BuiltinProviderType,
  ExecutionContext,
  ForkOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HookCallback,
  HookInput,
  HookOutput,
  InputSubmission,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PendingSessionInput,
  PromptResult,
  ProviderConfig,
  ProviderType,
  ResumeOptions,
  SendOptions,
  SessionHandoffResult,
  SessionOptions,
  SessionEventStore,
  SessionPersistence,
  SessionRepository,
  SessionRepositoryCompactionMetadata,
  SessionRepositoryHealth,
  SessionRepositoryMessageMetadata,
  SessionRepositoryStorageStats,
  SessionRepositorySubagentInfo,
  SessionRepositorySubagentRef,
  SessionTool,
  StreamMessage,
  StreamOptions,
  SubagentInfo,
  TokenUsage,
  ToolCallRecord,
  ToolDefinition,
  ToolResult,
} from './session/index.js';
// --- Session ---
export {
  createSession,
  forkSession,
  InputPriority,
  prompt,
  resumeSession,
} from './session/index.js';
// --- Tool authoring primitives ---
export type {
  ToolCatalogEntry,
  ToolCatalogReadView,
  ToolCatalogSourcePolicy,
  ToolSourceInfo,
  ToolSourceKind,
  ToolTrustLevel,
} from './tools/catalog/index.js';
export { ToolCatalog } from './tools/catalog/index.js';
export { createTool, defineTool, toolFromDefinition } from './tools/core/createTool.js';
export type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  FunctionDeclaration,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDescription,
  ToolDescriptionResolver,
  ToolDisplayContent,
  ToolEffect,
  ToolEffectYield,
  ToolError,
  ToolExecution,
  ToolExecutionLifecycle,
  ToolExecutionStartedLifecycle,
  ToolExposureConfig,
  ToolExposureMode,
  ToolInvocationLifecycle,
  ToolMessage,
  ToolModelContent,
  ToolPermissionResolution,
  ToolProgress,
  ToolScheduledLifecycle,
  ToolSchema,
  ToolSettledLifecycle,
  ToolYield,
} from './tools/types/index.js';
export {
  collectToolExecution,
  completeToolExecution,
  ToolErrorType,
} from './tools/types/index.js';
export { ToolKind, ToolSideEffect } from './tools/types/ToolKind.js';
export {
  AgentId,
  CommandId,
  CredentialLeaseId,
  EventId,
  EventSequence,
  ExecutionCheckpointId,
  ExecutionId,
  ExecutionLeaseId,
  FencingToken,
  InputId,
  MessageId,
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
  WorkerId,
} from './types/branded.js';
// --- Constants & types ---
export type {
  JsonObject,
  JsonValue,
  McpServerConfig,
  OutputFormat,
  SandboxSettings,
} from './types/common.js';
export {
  HookEvent,
  MessageRole,
  PermissionDecision,
  PermissionMode,
  StreamMessageType,
} from './types/constants.js';
export type { AgentLogger, LogEntry, LogLevelName } from './types/logging.js';
export type {
  CanUseTool,
  CanUseToolOptions,
  PermissionHandler,
  PermissionHandlerRequest,
  PermissionResult,
  PermissionRuleValue,
  PermissionUpdate,
} from './types/permissions.js';
// --- Permission system ---
export {
  createCompositePermissionHandler,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createPermissionHandlerFromCanUseTool,
  createRuleBasedPermissionHandler,
} from './types/permissions.js';
export type { Assert, Extends, IsEqual, KeysEqual } from './types/typeAssertions.js';
// --- Error utilities ---
export { getErrorCode, getErrorMessage, getErrorName, toError } from './utils/errorUtils.js';
// --- Lazy initialization utilities ---
export { lazySingleton } from './utils/lazySingleton.js';
