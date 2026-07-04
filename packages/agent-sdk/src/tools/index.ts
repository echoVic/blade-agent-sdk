import { ToolCatalog as RootToolCatalog } from '../../../../src/tools/catalog/ToolCatalog.js';
import {
  createTool as createRootTool,
  defineTool as defineRootTool,
  toolFromDefinition as rootToolFromDefinition,
} from '../../../../src/tools/core/createTool.js';
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
  ToolExecutionUpdate,
  ToolExposureConfig,
  ToolExposureMode,
  ToolResult,
  ToolSchema,
} from './types/index.js';
import { ToolErrorType } from './types/index.js';
import { ToolKind } from './types/ToolKind.js';

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

export class ToolCatalog implements ToolCatalogReadView {
  private readonly root: RootToolCatalog;

  constructor(registry?: unknown) {
    this.root = new RootToolCatalog(registry as never);
  }

  getRegistry(): unknown {
    return this.root.getRegistry();
  }

  register<TParams>(
    tool: Tool<TParams>,
    source?: ToolSourceInfo,
  ): void {
    this.root.register(tool as never, source);
  }

  registerAll<TParams>(
    tools: Tool<TParams>[],
    source?: ToolSourceInfo,
  ): void {
    this.root.registerAll(tools as never[], source);
  }

  registerMcpTool<TParams>(
    tool: Tool<TParams>,
    source?: ToolSourceInfo,
  ): void {
    this.root.registerMcpTool(tool as never, source);
  }

  unregister(name: string): boolean {
    return this.root.unregister(name);
  }

  removeMcpTools(serverName: string): number {
    return this.root.removeMcpTools(serverName);
  }

  get(name: string): Tool | undefined {
    return this.root.get(name) as unknown as Tool | undefined;
  }

  has(name: string): boolean {
    return this.root.has(name);
  }

  getAll(): Tool[] {
    return this.root.getAll() as unknown as Tool[];
  }

  getEntries(): ToolCatalogEntry[] {
    return this.root.getEntries() as unknown as ToolCatalogEntry[];
  }

  getEntry(name: string): ToolCatalogEntry | undefined {
    return this.root.getEntry(name) as unknown as ToolCatalogEntry | undefined;
  }

  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.root.getFunctionDeclarations() as unknown as FunctionDeclaration[];
  }

  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[] {
    return this.root.getFunctionDeclarationsByMode(mode) as unknown as FunctionDeclaration[];
  }

  search(query: string): Tool[] {
    return this.root.search(query) as unknown as Tool[];
  }
}

export function createTool<TSchema extends import('zod').z.ZodSchema>(
  config: ToolConfig<TSchema, import('zod').z.infer<TSchema>>,
): Tool<import('zod').z.infer<TSchema>> {
  return createRootTool(config as never) as unknown as Tool<import('zod').z.infer<TSchema>>;
}

export function defineTool<TParams = JsonObject, TData extends JsonValue = JsonValue>(
  definition: ToolDefinition<TParams, TData>,
): ToolDefinition<TParams, TData> {
  return defineRootTool(definition as never) as unknown as ToolDefinition<TParams, TData>;
}

export function toolFromDefinition<TParams = JsonObject>(
  definition: ToolDefinition<TParams>,
): Tool<TParams> {
  return rootToolFromDefinition(definition as never) as unknown as Tool<TParams>;
}

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
  ToolExecutionUpdate,
  ToolExposureConfig,
  ToolExposureMode,
  ToolResult,
  ToolSchema,
};
export { ToolErrorType, ToolKind };
