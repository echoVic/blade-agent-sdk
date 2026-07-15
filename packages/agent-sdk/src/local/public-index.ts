import type {
  JsonObject,
  JsonValue,
  NetworkSandboxSettings,
  SandboxSettings,
} from '../types/common.js';
import type { z } from 'zod';
import type { Tool } from '../tools/types/index.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpToolCallResponse {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: JsonObject;
}

export interface SdkTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (params: JsonObject) => Promise<McpToolResponse>;
}

export type McpToolResponse = {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: JsonObject;
};

export interface SdkMcpServerHandle {
  name: string;
  version: string;
  createClientTransport: () => Promise<unknown>;
  server: unknown;
}

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  updatedAt: number;
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface MemoryStore {
  save(input: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
}

export interface FileAccessRecord {
  filePath: string;
  accessTime: number;
  mtime: number;
  sessionId: string;
  lastOperation: 'read' | 'edit' | 'write';
}

export interface FileAccessLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export declare class FileAccessTracker {
  private constructor();
  static getInstance(logger?: FileAccessLogger): FileAccessTracker;
  static resetInstance(): void;
  setLogger(logger: FileAccessLogger): void;
  recordFileRead(filePath: string, sessionId: string): Promise<void>;
  recordFileEdit(
    filePath: string,
    sessionId: string,
    operation?: 'edit' | 'write',
  ): Promise<void>;
  hasFileBeenRead(filePath: string, sessionId?: string): boolean;
  checkFileModification(filePath: string): Promise<{ modified: boolean; message?: string }>;
  checkExternalModification(filePath: string): Promise<{ isExternal: boolean; message?: string }>;
  getFileRecord(filePath: string): FileAccessRecord | undefined;
  clearFileRecord(filePath: string): void;
  clearAll(): void;
  clearSession(sessionId: string): void;
  getTrackedFiles(): string[];
  getTrackedFileCount(): number;
}

export interface LocalFileStat {
  size: number;
  isDirectory: boolean;
  mtime: Date;
}

export interface LocalFileSystemPort {
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<LocalFileStat | undefined>;
  readTextFile(filePath: string): Promise<string>;
  readBinaryFile(filePath: string): Promise<Uint8Array>;
}

export interface ReadToolOptions {
  fileSystem?: LocalFileSystemPort;
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileRead'>;
}

export declare class FileSystemMemoryStore implements MemoryStore {
  constructor(dir?: string);
  save(input: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
}

export declare class MemoryManager {
  constructor(store: MemoryStore);
  save(input: MemoryInput): Promise<Memory>;
  get(name: string): Promise<Memory | undefined>;
  list(): Promise<Memory[]>;
  delete(name: string): Promise<void>;
  search(query: string): Promise<Memory[]>;
  readIndexContent(): Promise<string>;
}

export interface SandboxCapabilities {
  available: boolean;
  type: 'bubblewrap' | 'seatbelt' | 'none';
  version?: string;
  features: {
    fileSystemIsolation: boolean;
    networkIsolation: boolean;
    processIsolation: boolean;
  };
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
  requiresPermission?: boolean;
  isExcluded?: boolean;
}

export interface SandboxExecutionContext {
  command: string;
  dangerouslyDisableSandbox?: boolean;
  workDir?: string;
}

export interface SandboxExecutionOptions {
  workDir: string;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  allowNetwork?: boolean;
  allowedNetworkHosts?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export declare class SandboxExecutor {
  static getInstance(...args: unknown[]): SandboxExecutor;
  static resetInstance(): void;
  configure(settings: SandboxSettings): void;
  getCapabilities(): SandboxCapabilities;
  isEnabled(): boolean;
  canUseSandbox(): boolean;
  wrapCommand(command: string, options: SandboxExecutionOptions): string;
  buildExecutionOptions(
    workDir: string,
    networkSettings?: NetworkSandboxSettings,
  ): SandboxExecutionOptions;
}

export declare class SandboxService {
  static getInstance(): SandboxService;
  static resetInstance(): void;
  configure(settings: SandboxSettings): void;
  getSettings(): SandboxSettings;
  isEnabled(): boolean;
  shouldAutoAllowBash(): boolean;
  isCommandExcluded(command: string): boolean;
  allowsUnsandboxedCommands(): boolean;
  checkCommand(ctx: SandboxExecutionContext): SandboxCheckResult;
  shouldIgnoreFileViolation(filePath: string): boolean;
  shouldIgnoreNetworkViolation(target: string): boolean;
  getNetworkSettings(): NetworkSandboxSettings;
  allowsLocalBinding(): boolean;
  isUnixSocketAllowed(socketPath: string): boolean;
  wrapCommandForSandbox(command: string, workDir: string): string;
  getCapabilities(): SandboxCapabilities;
}

export interface BuiltinToolsOptions {
  memoryManager?: MemoryManager;
  sessionId?: unknown;
  configDir?: string;
  mcpRegistry?: unknown;
  includeMcpProtocolTools?: boolean;
  subagentRegistry?: unknown;
}

export declare function createSdkMcpServer(config: {
  name: string;
  version: string;
  tools: SdkTool[];
}): Promise<SdkMcpServerHandle>;
export declare function tool<TSchema extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  schema: TSchema,
  handler: (params: { [K in keyof TSchema]: z.infer<TSchema[K]> }) => Promise<McpToolResponse>,
): SdkTool;
export declare function getSandboxExecutor(...args: unknown[]): SandboxExecutor;
export declare function getSandboxService(...args: unknown[]): SandboxService;
export declare function createReadTool(options?: ReadToolOptions): Tool;
export interface WriteToolOptions {
  fileSystem?: LocalFileSystemPort;
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileEdit' | 'hasFileBeenRead'>;
}
export declare function createWriteTool(options?: WriteToolOptions): Tool;
export interface EditToolOptions {
  fileSystem?: LocalFileSystemPort & { writeTextFile: (filePath: string, content: string) => Promise<void> };
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileEdit' | 'hasFileBeenRead'>;
  snapshotManagerProvider?: (sessionId: string) => unknown;
  sensitivePathCheck?: (filePath: string) => boolean;
}
export declare function createEditTool(options?: EditToolOptions): Tool;
export declare function createGrepTool(): Tool;
export declare function createGlobTool(): Tool;
export declare function createNotebookEditTool(): Tool;
export declare function createAskUserQuestionTool(): Tool;
export declare function createEnterPlanModeTool(): Tool;
export declare function createExitPlanModeTool(): Tool;
export interface CreateTodoWriteToolOptions {
  sessionId: string;
  configDir?: string;
}
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'high' | 'medium' | 'low';
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm: string;
  priority: TodoPriority;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
export interface TodoStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}
export interface ValidationResult {
  valid: boolean;
  error?: string;
}
export declare function createTodoWriteTool(opts: CreateTodoWriteToolOptions): Tool;
export declare function getBuiltinTools(options?: BuiltinToolsOptions): Promise<Tool[]>;
export declare function createMemoryReadTool(args: { manager: MemoryManager }): Tool;
export declare function createMemoryWriteTool(args: { manager: MemoryManager }): Tool;

export type LocalAdapterValue = JsonValue;

export declare function getVersion(): string;
export declare function getPackageName(): string;

export interface EnvironmentInfo {
  workingDirectory?: string;
  projectRoot?: string;
  platform: string;
  nodeVersion: string;
  currentDate: string;
  homeDirectory: string;
}

export declare function getEnvironmentInfo(workingDir?: string): EnvironmentInfo;
export declare function getEnvironmentContext(workingDir?: string): string;

export declare function normalizePath(inputPath: string, workspaceRoot: string): string;
export declare function checkRestricted(absolutePath: string): void;
export declare function validatePath(inputPath: string, workspaceRoot: string): Promise<string>;
export declare function getRelativePath(absolutePath: string, workspaceRoot: string): string;
export declare function isWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean;

export declare const PathSecurity: {
  normalize: typeof normalizePath;
  checkRestricted: typeof checkRestricted;
  validatePath: typeof validatePath;
  getRelativePath: typeof getRelativePath;
  isWithinWorkspace: typeof isWithinWorkspace;
};
