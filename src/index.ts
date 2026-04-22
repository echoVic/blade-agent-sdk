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
export type { SdkErrorOptions } from './errors/index.js';
// --- Error hierarchy ---
export {
  AbortError,
  ConfigError,
  PermissionDeniedError,
  SdkError,
  ToolExecutionError,
} from './errors/index.js';
export type {
  McpToolCallResponse,
  McpToolDefinition,
  SdkMcpServerHandle,
  SdkTool,
  ToolResponse as McpToolResponse,
} from './mcp/index.js';
export { createSdkMcpServer, tool } from './mcp/index.js';
export type { Memory, MemoryInput, MemoryStore, MemoryType } from './memory/index.js';
// --- Memory ---
export { FileSystemMemoryStore, MemoryManager } from './memory/index.js';
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
export {
  createContextSnapshot,
  hasFilesystemCapability,
  mergeContext,
} from './runtime/index.js';
export type {
  AgentDefinition,
  ExecutionContext,
  ForkOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HookCallback,
  HookInput,
  HookOutput,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PromptResult,
  ProviderConfig,
  ProviderType,
  ResumeOptions,
  SendOptions,
  SessionOptions,
  StreamMessage,
  StreamOptions,
  SubagentInfo,
  TokenUsage,
  ToolCallRecord,
  ToolDefinition,
  ToolResult,
} from './session/index.js';
export { createSession, forkSession, prompt, resumeSession } from './session/index.js';
// --- Tool authoring primitives (stable) ---
export { getBuiltinTools } from './tools/builtin/index.js';
export { createMemoryReadTool, createMemoryWriteTool } from './tools/builtin/memory/index.js';
export type {
  ToolCatalogEntry,
  ToolCatalogReadView,
  ToolCatalogSourcePolicy,
  ToolSourceInfo,
  ToolSourceKind,
  ToolTrustLevel,
} from './tools/catalog/index.js';
// --- Catalog & exposure (consumed by session layer) ---
export { ToolCatalog } from './tools/catalog/index.js';
export { createTool, defineTool, toolFromDefinition } from './tools/core/createTool.js';
export type {
  FunctionDeclaration,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolExposureConfig,
  ToolExposureMode,
  ToolSchema,
} from './tools/types/index.js';
export { ToolKind } from './tools/types/ToolKind.js';
// --- Permission system ---
export type {
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
export {
  createCompositePermissionHandler,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createPermissionHandlerFromCanUseTool,
  createRuleBasedPermissionHandler,
} from './types/permissions.js';
