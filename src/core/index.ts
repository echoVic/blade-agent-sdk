// Browser-safe protocol, constants, and type exports.
// Keep this entry free of Node-only runtime imports.

export type { ProviderRegistryErrorCode } from '../errors/ProviderRegistryError.js';
export { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
export type { McpServerConfig } from '../mcp/config.js';
export * from '../middleware/index.js';
export type {
  BuiltinProviderType,
  ModelConfig,
  ModelContent,
  ModelIdentity,
  ModelImageContent,
  ModelMessage,
  ModelProviderOptions,
  ModelResponse,
  ModelRetryConfig,
  ModelRetryEvent,
  ModelService,
  ModelServiceConfig,
  ModelSideQueryOptions,
  ModelStreamChunk,
  ModelStreamToolCall,
  ModelTextContent,
  ModelToolCall,
  ModelToolCallDelta,
  ModelToolDefinition,
  ModelUsage,
  OutputFormat,
  ProviderConnectionConfig,
  ProviderType,
  QuerySource,
  TokenUsage,
} from '../model/index.js';
export {
  isBuiltinProviderType,
  normalizeModelUsage,
  PROVIDER_TYPES,
  resolveModelIdentity,
} from '../model/index.js';
export type {
  AgentTrace,
  ObservabilityOptions,
  TraceEvent,
  TracePayloadSummary,
  TraceSink,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from '../observability/index.js';
export * from '../protocol/index.js';
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
} from '../runtime/index.js';
export type { SandboxSettings } from '../sandbox/config.js';
export type { ProviderAdapter } from '../services/ProviderRegistry.js';
export { ProviderRegistry } from '../services/ProviderRegistry.js';
export * from '../session/events/core.js';
export type {
  PersistedToolUse,
  SessionEventStore,
  SessionPersistence,
  SessionRepository,
  SessionRepositoryCompactionMetadata,
  SessionRepositoryHealth,
  SessionRepositoryMessageMetadata,
  SessionRepositoryStorageStats,
  SessionRepositorySubagentInfo,
  SessionRepositorySubagentRef,
} from '../session/SessionRepository.js';
export type {
  InputSubmission,
  PendingSessionInput,
  SendOptions,
  SessionOptions,
  SessionStreamEvent,
  StreamOptions,
} from '../session/types.js';
export { InputPriority } from '../session/types.js';
export type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  ExecutionContext,
  FunctionDeclaration,
  ToolBehavior,
  ToolConfig,
  ToolDefinition,
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
  ToolResult,
  ToolScheduledLifecycle,
  ToolSchema,
  ToolSettledLifecycle,
  ToolYield,
} from '../tools/types/index.js';
export {
  collectToolExecution,
  completeToolExecution,
  ToolErrorType,
} from '../tools/types/index.js';
export { ToolKind, ToolSideEffect } from '../tools/types/kind.js';
export {
  HookEvent,
  MessageRole,
  PermissionDecision,
  PermissionMode,
  SessionStreamEventType,
} from '../types/constants.js';
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
  PartId,
  PermissionRequestId,
  RequestId,
  SessionId,
  SpanId,
  ToolAttemptId,
  ToolUseId,
  TraceEventId,
  TraceId,
  TurnId,
  WorkerId,
} from '../types/identifiers.js';
export type { JsonObject, JsonValue } from '../types/json.js';
export type {
  CanUseTool,
  CanUseToolOptions,
  PermissionHandler,
  PermissionHandlerRequest,
  PermissionResult,
  PermissionRuleValue,
  PermissionsConfig,
  PermissionUpdate,
} from '../types/permissions.js';
