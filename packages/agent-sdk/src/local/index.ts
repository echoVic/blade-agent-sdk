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
  Snapshot,
  SnapshotManagerOptions,
  SnapshotMetadata,
} from './file/index.js';
export {
  createReadTool,
  FileAccessTracker,
  SnapshotManager,
} from './file/index.js';
export { isSensitivePath } from './file/sensitivePathCheck.js';
export {
  generateDiffSnippet,
  generateDiffSnippetWithMatch,
} from './file/diffUtils.js';
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
