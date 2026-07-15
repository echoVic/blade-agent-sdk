// Node-local capabilities: builtin tools, MCP, memory, and sandbox adapters.
// Browser consumers should use @blade-ai/agent-sdk/core or a remote server API.

export type {
  McpToolCallResponse,
  McpToolDefinition,
  McpToolResponse,
  SdkMcpServerHandle,
  SdkTool,
} from './mcp.js';
export { createSdkMcpServer, tool } from './mcp.js';
export { FileSystemMemoryStore, MemoryManager } from './memory.js';
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
export { createListMcpResourcesTool, createReadMcpResourceTool } from './mcp-tools/index.js';
export { webFetchTool, webSearchTool } from './web/index.js';
export { getSearchCache, SearchCache, getAllProviders, getProviderCount } from './web/index.js';
export type { WebSearchResult, SearchProvider, CacheConfig, CacheStats } from './web/index.js';
export { createEnterPlanModeTool, enterPlanModeTool } from './plan/enterPlanMode.js';
export { createExitPlanModeTool, exitPlanModeTool } from './plan/exitPlanMode.js';
export { createTodoWriteTool, todoWriteTool, TodoManager } from './todo/index.js';
export { TodoItemSchema } from './todo/index.js';
export type { CreateTodoWriteToolOptions, TodoItem, TodoPriority, TodoStats, TodoStatus, ValidationResult } from './todo/index.js';
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
  SandboxCapabilities,
  SandboxCheckResult,
  SandboxExecutionContext,
  SandboxExecutionOptions,
} from './sandbox.js';
export {
  getSandboxExecutor,
  getSandboxService,
  SandboxExecutor,
  SandboxService,
} from './sandbox.js';
export {
  createMemoryReadTool,
  createMemoryWriteTool,
  getBuiltinTools,
} from './builtin-tools.js';
export type { BuiltinToolsOptions } from './builtin-tools.js';
export { getVersion, getPackageName } from './packageInfo.js';
export { getEnvironmentContext, getEnvironmentInfo, type EnvironmentInfo } from './environment.js';
export { normalizePath, PathSecurity, checkRestricted, getRelativePath, isWithinWorkspace, validatePath } from './pathSecurity.js';
