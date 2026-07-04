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
export declare function createMemoryReadTool(args: { manager: MemoryManager }): Tool;
export declare function createMemoryWriteTool(args: { manager: MemoryManager }): Tool;

export type LocalAdapterValue = JsonValue;
