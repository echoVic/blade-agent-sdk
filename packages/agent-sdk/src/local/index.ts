export type {  PreparedPermissionMatcher, ToolExposureConfig, ToolExposureMode } from './toolDefinitionTypes.js';
// Node-local capabilities: builtin tools, MCP, memory, and sandbox adapters.
// Browser consumers should use @blade-ai/agent-sdk/core or a remote server API.

export { TokenCounter } from './TokenCounter.js';
export type {  InternalLogger } from './Logger.js';
export { LogCategory } from './Logger.js';
export { LogLevel } from './Logger.js';
export { createRootLogger } from './Logger.js';
export { NOOP_LOGGER } from './Logger.js';
export type {  LogLevelName, LogEntry, AgentLogger } from './loggingTypes.js';
export { FileLockManager } from './FileLockManager.js';

export type {  McpToolCallResponse, McpToolDefinition } from './mcpTypes.js';
export { McpConnectionStatus } from './mcpTypes.js';
export type { 
  McpToolResponse,
  SdkMcpServerHandle,
  SdkTool,
} from './mcp.js';
export { createSdkMcpServer, tool } from './mcp.js';
export { FileSystemMemoryStore } from './memory.js';
export { MemoryManager } from './MemoryManager.js';
export type {  Memory, MemoryInput, MemoryType } from './memory.js';
export type {  MemoryStore } from './MemoryStore.js';
export type { 
  FileAccessLogger,
  FileAccessRecord,
  LocalFileStat,
  LocalFileSystemPort,
  ReadToolOptions,
  WriteToolOptions,
  EditToolOptions,
  Snapshot,
  SnapshotManagerOptions,
  SnapshotMetadata,
} from './file/index.js';
export {
  createReadTool,
  createWriteTool,
  createEditTool,
  FileAccessTracker,
  SnapshotManager,
} from './file/index.js';
export { createGrepTool, grepTool } from './search/index.js';
export { createGlobTool, globTool } from './search/index.js';
export { createNotebookEditTool, notebookEditTool } from './notebook/notebookEdit.js';
export { createAskUserQuestionTool, askUserQuestionTool } from './system/askUserQuestion.js';
export { discoverToolsTool } from './system/discoverTools.js';
export { skillTool } from './system/skill.js';
export { bashTool, killShellTool, BackgroundShellManager, OutputTruncator } from './shell/index.js';
export {
  createTaskTool,
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskStopTool,
  createTaskUpdateTool,
  taskOutputTool,
  TaskStore,
} from './task/index.js';
export { createListMcpResourcesTool, createReadMcpResourceTool } from './mcp-tools/index.js';
export { webFetchTool, webSearchTool } from './web/index.js';
export { getSearchCache, SearchCache, getAllProviders, getProviderCount } from './web/index.js';
export type {  WebSearchResult, SearchProvider, CacheConfig, CacheStats } from './web/index.js';
export { createEnterPlanModeTool, enterPlanModeTool } from './plan/enterPlanMode.js';
export { createExitPlanModeTool, exitPlanModeTool } from './plan/exitPlanMode.js';
export { createTodoWriteTool, todoWriteTool, TodoManager } from './todo/index.js';
export { TodoItemSchema } from './todo/index.js';
export type {  CreateTodoWriteToolOptions, TodoItem, TodoPriority, TodoStats, TodoStatus, ValidationResult } from './todo/index.js';
export { FileFilter, DEFAULT_EXCLUDE_DIRS } from './filePatterns.js';
export { isSensitivePath } from './file/sensitivePathCheck.js';
export {
  generateDiffSnippet,
  generateDiffSnippetWithMatch,
} from './file/diffUtils.js';
export {
  flexibleMatch,
  MatchStrategy,
  unescapeString,
  type MatchResult,
} from './file/editCorrector.js';
export type { 
  SandboxCheckResult,
  SandboxExecutionContext,
} from './sandbox.js';
export {
  getSandboxService,
  SandboxService,
} from './sandbox.js';
export * from './SandboxExecutor.js';
export {
  createMemoryReadTool,
  createMemoryWriteTool,
  getBuiltinTools,
} from './builtin-tools.js';
export type {  BuiltinToolsOptions } from './builtin-tools.js';
export { getVersion, getPackageName } from './packageInfo.js';
export { getEnvironmentContext, getEnvironmentInfo, type EnvironmentInfo } from './environment.js';
export { normalizePath, PathSecurity, checkRestricted, getRelativePath, isWithinWorkspace, validatePath } from './pathSecurity.js';
export {
  SensitivityLevel,
  check,
  checkMultiple,
  filterSensitive,
  getSensitivePatterns,
  getSensitivePaths,
  SensitiveFileDetector,
} from './SensitiveFileDetector.js';
export type {  SensitiveFileCheckResult } from './SensitiveFileDetector.js';

// Branded types + factory functions
export { AgentId, MessageId, SessionId, ToolUseId } from './branded.js';

// Path utilities
export * from './pathUtils.js';

// Context seed types
export type {  CompressedContext, ContextMessage, ContextStorageOptions } from './context.js';
export type {  JSONLEventType, PartInfo, PartType, MessageInfo, SessionEvent, SessionEventBase, SessionInfo } from './context.js';
export type {  ToolCall, SystemContext, SessionContext, ConversationContext, WorkspaceContext, ContextLayer, ContextData } from './context.js';
export type {  ContextFilter, ContextManagerOptions } from './contextTypes.js';

// Context Processors
export { ContextCompressor } from './ContextCompressor.js';
export { ContextFilterProcessor } from './ContextFilterProcessor.js';

// Context Compaction Strategies
export { microcompact } from './microcompactStrategy.js';
export type {  MicrocompactOptions, MicrocompactResult } from './microcompactStrategy.js';
export { softCompact } from './softCompactionStrategy.js';
export type {  SoftCompactionOptions, SoftCompactionResult } from './softCompactionStrategy.js';

export { CacheStore } from './CacheStore.js';
export { BashClassifier } from './BashClassifier.js';
export type {  BashCommandCategory, BashClassification } from './BashClassifier.js';
export { SecureProcessExecutor } from './SecureProcessExecutor.js';

// Hook Configuration
export { DEFAULT_HOOK_CONFIG, mergeHookConfig, parseEnvConfig } from './HookConfig.js';
export type {  HookConfig } from './HookConfig.js';

// Hook Types
export type { 
  HookInputBase,
    Hook,
    HookSpecificOutput,
  HookMatcher,
  HookExecutionContext,
  HookExecutionResult,
  PreToolUseInput,
  PostToolUseInput,
  StopInput,
  PostToolUseFailureInput,
  PermissionRequestInput,
  UserPromptSubmitInput,
  SessionStartInput,
  SessionEndInput,
  SubagentStartInput,
  SubagentStopInput,
  TaskCompletedInput,
  NotificationInput,
  CompactionInput,
  StopFailureInput,
  PreCompactInput,
  PostCompactInput,
  ElicitationInput,
  ElicitationResultInput,
  ConfigChangeInput,
  CwdChangedInput,
  FileChangedInput,
  InstructionsLoadedInput,
  CommandHook,
  ProcessResult,
  PreToolHookResult,
  PostToolHookResult,
  StopHookResult,
  PostToolUseFailureHookResult,
  PermissionRequestHookResult,
  UserPromptSubmitHookResult,
  SessionStartHookResult,
  SessionEndHookResult,
  SubagentStartHookResult,
  SubagentStopHookResult,
  TaskCompletedHookResult,
  NotificationHookResult,
  CompactionHookResult,
  StopFailureHookResult,
  PreCompactHookResult,
  PostCompactHookResult,
  ElicitationHookResult,
  ElicitationResultHookResult,
  ConfigChangeHookResult,
  CwdChangedHookResult,
  FileChangedHookResult,
  InstructionsLoadedHookResult,
} from './hookTypes.js';
export {
  DecisionBehavior,
  HookType,
  HookExitCode,
} from './hookTypes.js';

// Hook Schemas
export {
  getHookSchemas,
  safeParseHookOutput,
  JsonValueSchema,
} from './hookSchemas.js';

export { FileAnalyzer, analyzeFiles, readFilesContent, type FileContent, type FileReference } from './FileAnalyzer.js';
export { Matcher } from './Matcher.js';
export type {  MatcherConfig, MatchContext } from './Matcher.js';
// JSONL Store
export { JSONLStore } from './JSONLStore.js';
export { ContextMemoryStore } from './ContextMemoryStore.js';

export type {  RuntimeContext } from './RuntimeContext.js';
export type {  ContextSnapshot } from './ContextSnapshot.js';
export { hasFilesystemCapability, mergeContext, createContextSnapshot } from './ContextSnapshot.js';

export type { 
  RuntimePatchScope,
  RuntimePatchSkillInfo,
  RuntimeToolPolicyPatch,
  RuntimeModelOverride,
  RuntimeHookEvent,
  RuntimeHookRegistration,
  RuntimeToolDiscoveryPatch,
  RuntimePatchProvenance,
  RuntimePatchApplication,
  RuntimePatchSummary,
  RuntimePatch,
} from './RuntimePatch.js';
export { summarizeRuntimePatchApplications } from './RuntimePatch.js';
export { configureStreamDebug, streamDebug } from './StreamDebugLogger.js';
export { HookExecutionGuard } from './HookExecutionGuard.js';
export { HookBus } from './HookBus.js';
export { OutputParser } from './OutputParser.js';
export { HookExecutor } from './HookExecutor.js';
export { HookManager } from './HookManager.js';
export { McpClient, ErrorType } from './McpClient.js';
export type { McpClientOptions } from './McpClient.js';
export { createMcpTool } from './createMcpTool.js';
export { McpRegistry } from './McpRegistry.js';
export type {  ToolResponse } from './SdkMcpServer.js';
export type { 
  ReadMetadata,
  WriteMetadata,
  EditMetadata,
  EditErrorMetadata,
  GlobMetadata,
  GrepMetadata,
  BashBackgroundMetadata,
  BashForegroundMetadata,
  WebSearchMetadata,
  WebFetchMetadata,
  ToolResultMetadata,
} from './toolMetadata.js';
export { isGlobMetadata, isEditMetadata } from './toolMetadata.js';
export {
  getRuntimePatchEffect,
  normalizeToolEffects,
  normalizePermissionEffects,
} from './toolEffects.js';

// Skills types
export type { 
  SkillSourceKind,
  SkillTrustLevel,
  SkillShellPolicy,
  SkillHookPolicy,
  SkillActivationScope,
  SkillSource,
  SkillRuntimeEffects,
  SkillActivationConditions,
  SkillActivationContext,
  SkillHookSpec,
  SkillShellConfig,
  SkillAssetEntry,
  SkillAssetManifest,
  SkillMetadata,
  SkillContent,
  SkillParseResult,
  SkillSourceConfig,
  SkillRegistryConfig,
  SkillDiscoveryResult,
} from './skillsTypes.js';
export { defaultSkillSource } from './skillsTypes.js';
export {
  collectSkillActivationPaths,
  isSkillAvailableInContext,
  filterSkillsByActivation,
} from './skillsActivation.js';

// Skills loader
export {
  processInlineCommands,
  discoverSkillAssets,
  loadSkillMetadata,
  loadSkillContent,
  discoverSkillScripts,
  hasSkillFile,
} from './skillsLoader.js';

// Skills registry
export { SkillRegistry, getSkillRegistry, discoverSkills } from './skillsRegistry.js';
export { injectSkillsMetadata } from './skillsInject.js';

// Observability
export { TraceRecorder } from './TraceRecorder.js';
export type { 
  TraceStatus,
  TraceSpanKind,
  TracePayloadSummary,
  TraceEvent,
  TraceSpan,
  AgentTrace,
  TraceSink,
  ObservabilityOptions,
  HookTraceCollector,
} from './observabilityTypes.js';
export { HookEvent } from './constants.js';
export { MessageRole } from './constants.js';
export { PermissionDecision } from './constants.js';
export { PermissionMode } from './constants.js';
export { StreamMessageType } from './constants.js';
export { getContextCwd } from './runtimeUtils.js';
export type {  RuntimeContextPatch } from './RuntimeContextPatch.js';
export type { 
  PermissionRuleValue,
  PermissionUpdate,
  ToolEffect,
  PermissionResult,
} from './permissionTypes.js';
export type { 
  CanUseToolOptions,
  CanUseTool,
  PermissionHandlerRequest,
  PermissionHandler,
} from './permissions.js';
export {
  createPermissionHandlerFromCanUseTool,
  createModePermissionHandler,
  createRuleBasedPermissionHandler,
  createPathSafetyPermissionHandler,
  createCompositePermissionHandler,
} from './permissions.js';
export { cloneContentPart, cloneJsonValue, cloneMessage, cloneToolCall } from './messageUtils.js';
export { registerCleanup, gracefulShutdown, resetCleanupRegistry, type CleanupFn, type CleanupHandle, type GracefulShutdownOptions } from './CleanupRegistry.js';
export { getFileSystemService, type FileSystemService } from './FileSystemService.js';

// Prompts
export { PLAN_MODE_SYSTEM_PROMPT, createPlanModeReminder } from './prompts.js';
export type {  LineRange, AtMention, AttachmentType, AttachmentMetadata, Attachment, CollectorOptions } from './promptProcessors.js';
export { AtMentionParser, extract, hasAtMentions, isValidPath, removeAtMentions } from './AtMentionParser.js';

// OAuth Types
export type { 
  OAuthToken,
  OAuthConfig,
  AuthorizationOAuthConfig,
  RefreshableOAuthConfig,
  OAuthCredentials,
  OAuthTokenResponse,
} from './oauthTypes.js';

// OAuth Storage
export { OAuthTokenStorage } from './OAuthTokenStorage.js';

// OAuth Provider
export { OAuthProvider } from './OAuthProvider.js';

// MCP Health Types
export { HealthStatus } from './mcpHealth.js';
export type {  HealthCheckConfig } from './mcpHealth.js';

// Session Kernel Store Adapter
export { createKernelStorePort } from './SessionKernelStoreAdapter.js';
export type {  KernelStorePortOptions, SessionMessageStore } from './SessionKernelStoreAdapter.js';

// Session Model Port
export { createSessionKernelModel, resolveSessionModelConfig } from './SessionModelPort.js';
export type {  SessionKernelModel } from './SessionModelPort.js';

// Session Kernel Hook Adapter
export { createKernelHookPort } from './SessionKernelHookAdapter.js';
export type {  HookRuntimeLike, KernelHookPortOptions } from './SessionKernelHookAdapter.js';

// MCP Capability Projector
export { projectMcpCapabilities } from './McpCapabilityProjector.js';

// MCP Server Types
export type {  McpClientLike, McpServerInfo } from './mcpServerTypes.js';

// Kernel Adapter Types
export type {  ExecutionPipelineLike, ToolRegistryLike } from './kernelAdapterTypes.js';

// Agent State Types
export type {  BackgroundAgentManagerLike, ConfirmationHandlerLike, ToolCatalogLike } from './turnStateTypes.js';

// Agent Types
export type {  AgentProgress, ChatContext, IBackgroundAgentController, IBackgroundAgentManager, IBackgroundAgentReader, TurnLimitResponse, UserMessageContent } from './agentTypes.js';

// Session Types
export type { StreamOptions, SendOptions, McpServerStatus, McpToolInfo, ForkSessionOptions, ForkSessionResult, HookCallback, HookInput, HookOutput, AgentDefinition, ModelInfo, PromptResult, ProviderConfig, StreamMessage, SubagentInfo, ToolCallRecord, SessionSummary, SessionSnapshot, SessionTimelineEntry, SessionToolCallState, SessionSubagentRef, SessionState, SessionStore, SessionAgentKernelOptions, SessionAgentKernelStreamOptions, ResumeOptions, ForkOptions } from './sessionTypes.js';

// Tool Catalog Types
export type {  ToolCatalogSourcePolicy, ToolSourceKind, ToolTrustLevel } from './toolCatalogTypes.js';
export type {  McpCapabilitySource, McpServerCapability, McpServerInfoForCapability, McpToolCapability } from './McpCapabilityProjector.js';

// Session Kernel Trace Adapter
export { createKernelTracePort } from './SessionKernelTraceAdapter.js';
export type {  KernelTracePortOptions } from './SessionKernelTraceAdapter.js';
export type {  BuildSystemPromptOptions, BuildSystemPromptResult } from './promptBuilder.js';
export { buildSystemPrompt } from './promptBuilder.js';
export type {  Assert, Extends, IsEqual, KeysEqual } from './typeAssertions.js';
export type {  RuntimeToolPolicySnapshot } from './exposureTypes.js';
export type {  AgentSessionStatus } from './agentSessionTypes.js';
export type {  AgentSession } from './agentSessionTypes.js';
export type {  AgentOptions, LoopOptions, LoopResult, PlanApprovalResult } from './agentLoopTypes.js';
export {  isPlanApprovalResult } from './agentLoopTypes.js';
export type {  AgentEvent, AgentStartEvent, AgentEndEvent, TurnStartEvent, TurnEndEvent, TurnRetryEvent, ContentDeltaEvent, ThinkingDeltaEvent, StreamEndEvent, ContentEvent, ThinkingEvent, ToolStartEvent, ToolResultEvent, ToolProgressEvent, ToolMessageEvent, ToolRuntimePatchEvent, ToolContextPatchEvent, ToolNewMessagesEvent, ToolPermissionUpdatesEvent, TokenUsageEvent, TokenUsageInfo, BudgetWarningEvent, CompactingEvent, TodoUpdateEvent, ApiRetryEvent, ModelFallbackEvent, RecoveryEvent, ErrorEvent } from './agentEvent.js';
export type {  LlmToolDefinition, LoopSkillState, LoopRecoveryState, LoopExecutionContext, TurnState } from './turnState.js';
export {  PlanExecutor } from './planExecutor.js';
export {  LoopState } from './loopState.js';
export {  AttachmentCollector } from './attachmentCollector.js';
export {  SubagentRegistry } from './subagentRegistry.js';
export {  AgentSessionStore } from './agentSessionStore.js';
export {  VercelAIChatService } from './vercelAIChatService.js';
export type {  StartBackgroundAgentOptions } from './backgroundAgentTypes.js';
export type {  CompactionRuntimeContext, CompactionHandlerLike } from './compactionTypes.js';
export type {  PreToolUseRuntimeResult, PostToolUseRuntimeResult } from './hookTypes.js';
export type {  SubagentRegistryLike, SubagentExecutorLike } from './subagentTypes.js';
export type {  ModelManagerLike } from './modelTypes.js';
export type {  AgentLoopConfig, AgentLoopHooks } from './adapterContracts.js';
export {  createChatServiceAsync } from './chatServiceFactory.js';
export { buildHookInput, extractMimeType, formatToolDescription, formatUnknown, inferAffectedPaths, isChatToolCall, isChatToolCallArray, isJsonObject, isPathLikeKey, isRecord, isSdkMcpServerHandle, isSessionToolCall, isSessionToolCallArray, isUsageMetadata, parseToolCallArguments, resolveStorageRoot, serverNameFromTool, stringifyContent, toMessageContent, toSessionPermissionUpdates, toSessionUsage, toSubagentConfig, toTimestamp, translateZodIssue, upsertContentPart } from './SessionRuntimeUtils.js';
