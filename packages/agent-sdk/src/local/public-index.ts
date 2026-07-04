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
export declare function getBuiltinTools(...args: unknown[]): Promise<Tool[]>;
export declare function createMemoryReadTool(args: { manager: MemoryManager }): Tool;
export declare function createMemoryWriteTool(args: { manager: MemoryManager }): Tool;

export type LocalAdapterValue = JsonValue;
