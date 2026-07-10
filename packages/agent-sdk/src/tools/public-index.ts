import type { z } from 'zod';
import type { JsonObject, JsonValue, PermissionMode } from '../types/common.js';
import type {
  FunctionDeclaration,
  FunctionToolCall,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolError,
  ToolExecutionOutcome,
  ToolExecutionOutcomeOf,
  ToolExecutionUpdate,
  ToolExecutionUpdateOf,
  ToolExposureConfig,
  ToolExposureMode,
  ToolResult,
  ToolSchema,
} from './types/index.js';

export type ToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';
export type ToolTrustLevel = 'trusted' | 'workspace' | 'remote';

export interface ToolSourceInfo {
  kind: ToolSourceKind;
  trustLevel: ToolTrustLevel;
  sourceId: string;
}

export interface ToolCatalogEntry {
  tool: Tool;
  source: ToolSourceInfo;
}

export interface ToolCatalogSourcePolicy {
  allowedSources?: ToolSourceKind[];
  allowedTrustLevels?: ToolTrustLevel[];
}

export interface ToolCatalogReadView {
  getAll(): Tool[];
  getEntries?(): ToolCatalogEntry[];
  getFunctionDeclarationsByMode?(mode?: PermissionMode): FunctionDeclaration[];
}

export declare class ToolCatalog implements ToolCatalogReadView {
  constructor(registry?: unknown);
  getRegistry(): unknown;
  register<TParams>(tool: Tool<TParams>, source?: ToolSourceInfo): void;
  registerAll<TParams>(tools: Tool<TParams>[], source?: ToolSourceInfo): void;
  registerMcpTool<TParams>(tool: Tool<TParams>, source?: ToolSourceInfo): void;
  unregister(name: string): boolean;
  removeMcpTools(serverName: string): number;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getAll(): Tool[];
  getEntries(): ToolCatalogEntry[];
  getEntry(name: string): ToolCatalogEntry | undefined;
  getFunctionDeclarations(): FunctionDeclaration[];
  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[];
  search(query: string): Tool[];
}

export declare function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>,
): Tool<z.infer<TSchema>>;

export declare function defineTool<TParams = JsonObject, TData extends JsonValue = JsonValue>(
  definition: ToolDefinition<TParams, TData>,
): ToolDefinition<TParams, TData>;

export declare function toolFromDefinition<TParams = JsonObject>(
  definition: ToolDefinition<TParams>,
): Tool<TParams>;

export type {
  FunctionDeclaration,
  FunctionToolCall,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolError,
  ToolExecutionOutcome,
  ToolExecutionOutcomeOf,
  ToolExecutionUpdate,
  ToolExecutionUpdateOf,
  ToolExposureConfig,
  ToolExposureMode,
  ToolResult,
  ToolSchema,
};
export { ToolErrorType } from './types/index.js';
export { ToolKind } from './types/ToolKind.js';
