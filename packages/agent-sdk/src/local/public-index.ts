import type { JsonObject, JsonValue } from '../types/common.js';
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
  description?: string;
  inputSchema?: JsonObject;
}

export type McpToolResponse = McpToolCallResponse;

export interface SdkMcpServerHandle {
  name: string;
  version: string;
  createClientTransport: () => Promise<unknown>;
  server: unknown;
}

export interface Memory {
  id: string;
  type: string;
  content: string;
  metadata?: JsonObject;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryInput {
  type: string;
  content: string;
  metadata?: JsonObject;
}

export interface MemoryStore {
  list(): Promise<Memory[]>;
  read(id: string): Promise<Memory | undefined>;
  write(input: MemoryInput): Promise<Memory>;
  delete(id: string): Promise<boolean>;
}

export declare class FileSystemMemoryStore implements MemoryStore {
  constructor(...args: unknown[]);
  list(): Promise<Memory[]>;
  read(id: string): Promise<Memory | undefined>;
  write(input: MemoryInput): Promise<Memory>;
  delete(id: string): Promise<boolean>;
}

export declare class MemoryManager {
  constructor(...args: unknown[]);
}

export interface SandboxCapabilities {
  available: boolean;
  reason?: string;
}

export interface SandboxCheckResult {
  available: boolean;
  reason?: string;
}

export interface SandboxExecutionContext {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string>;
  metadata?: JsonObject;
}

export interface SandboxExecutionOptions {
  command?: string;
  args?: string[];
  code?: string;
  language?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  context?: SandboxExecutionContext;
}

export declare class SandboxExecutor {
  constructor(...args: unknown[]);
}

export declare class SandboxService {
  constructor(...args: unknown[]);
}

export declare function createSdkMcpServer(...args: unknown[]): SdkMcpServerHandle;
export declare function tool(...args: unknown[]): unknown;
export declare function getSandboxExecutor(...args: unknown[]): SandboxExecutor;
export declare function getSandboxService(...args: unknown[]): SandboxService;
export declare function getBuiltinTools(...args: unknown[]): Promise<Tool[]>;
export declare function createMemoryReadTool(...args: unknown[]): Tool;
export declare function createMemoryWriteTool(...args: unknown[]): Tool;

export type LocalAdapterValue = JsonValue;
