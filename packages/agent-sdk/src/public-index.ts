import type { JsonObject } from './core/index.js';

export * from '@blade-ai/ai/deepseek';

export declare class SubagentExecutor {
  constructor(...args: unknown[]);
}

export declare class SubagentRegistry {
  constructor(...args: unknown[]);
}

export type SubagentColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray';
export type SubagentSource = 'builtin' | 'project' | 'user' | 'session';
export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  prompt: string;
  color?: SubagentColor;
  source?: SubagentSource;
  tools?: string[];
}
export interface SubagentContext {
  prompt: string;
  context?: JsonObject;
}
export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
}

export type {
  AgentTrace,
  CanUseTool,
  CanUseToolOptions,
  ContextSnapshot,
  JsonObject,
  JsonValue,
  McpServerConfig,
  ModelConfig,
  ObservabilityOptions,
  OutputFormat,
  PermissionHandler,
  PermissionHandlerRequest,
  PermissionResult,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionsConfig,
  ProviderType,
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
  SandboxSettings,
  SendOptions,
  StreamMessage,
  StreamOptions,
  TokenUsage,
  TraceEvent,
  TracePayloadSummary,
  TraceSink,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from './core/index.js';
export {
  createCompositePermissionHandler,
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  createPermissionHandlerFromCanUseTool,
  createRuleBasedPermissionHandler,
  HookEvent,
  MessageRole,
  PermissionDecision,
  PermissionMode,
  StreamMessageType,
} from './core/index.js';
export type {
  McpToolCallResponse,
  McpToolDefinition,
  McpToolResponse,
  SandboxCapabilities,
  SandboxCheckResult,
  SandboxExecutionContext,
  SandboxExecutionOptions,
  SdkMcpServerHandle,
  SdkTool,
} from './local/public-index.js';
export {
  createMemoryReadTool,
  createMemoryWriteTool,
  createSdkMcpServer,
  FileSystemMemoryStore,
  getBuiltinTools,
  getSandboxExecutor,
  getSandboxService,
  MemoryManager,
  SandboxExecutor,
  SandboxService,
  tool,
} from './local/public-index.js';
export type {
  AgentDefinition,
  AgentLogger,
  ForkOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HookCallback,
  HookInput,
  HookOutput,
  ISession,
  LogEntry,
  LogLevelName,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PromptResult,
  ProviderConfig,
  ResumeOptions,
  SessionContentPart,
  SessionHookEvent,
  SessionId,
  SessionImageContentPart,
  SessionMessage,
  SessionMessageRole,
  SessionOptions,
  SessionTextContentPart,
  SessionToolCall,
  SubagentInfo,
  TokenBudgetConfig,
  ToolCallRecord,
  UserMessageContent,
} from './session/public-index.js';
export {
  createSession,
  forkSession,
  prompt,
  resumeSession,
} from './session/public-index.js';
export type {
  FunctionDeclaration,
  FunctionToolCall,
  Tool,
  ToolBehavior,
  ToolCatalogEntry,
  ToolCatalogReadView,
  ToolCatalogSourcePolicy,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolError,
  ToolExecutionOutcome,
  ToolExecutionUpdate,
  ToolExposureConfig,
  ToolExposureMode,
  ToolResult,
  ToolSchema,
  ToolSourceInfo,
  ToolSourceKind,
  ToolTrustLevel,
} from './tools/public-index.js';
export {
  createTool,
  defineTool,
  ToolCatalog,
  ToolErrorType,
  ToolKind,
  toolFromDefinition,
} from './tools/public-index.js';
