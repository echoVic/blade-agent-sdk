// Browser-safe protocol, constants, and type exports.
// Keep this entry free of Node-only runtime imports.

export type { UserMessageContent } from '../agent/UserMessageContent.js';
export type { ProviderRegistryErrorCode } from '../errors/ProviderRegistryError.js';
export { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
export type { McpServerConfig } from '../mcp/config.js';
export * from '../middleware/index.js';
export type {
  BuiltinProviderType,
  ConversationMessage,
  ConversationMessageSource,
  ModelConfig,
  ModelContent,
  ModelIdentity,
  ModelImageContent,
  ModelMessage,
  ModelMessageProviderOptions,
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
  CONVERSATION_MESSAGE_SOURCES,
  isBuiltinProviderType,
  isConversationMessageSource,
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
export { ToolKind, ToolSideEffect } from '../tools/behavior.js';
export { defineTool } from '../tools/core/createTool.js';
export type { ToolServiceMap, ToolServiceName } from '../tools/services.js';
export type {
  BuiltinToolGroup,
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  ExecutionContext,
  RuntimeAccess,
  ToolBehavior,
  ToolDefinition,
  ToolDefinitionInput,
  ToolDescription,
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
  ToolSettledLifecycle,
  ToolYield,
} from '../tools/types/index.js';
export {
  collectToolExecution,
  completeToolExecution,
  ToolErrorType,
} from '../tools/types/index.js';
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
