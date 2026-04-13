import { PermissionMode } from '../../types/common.js';
import { ToolRegistry } from '../registry/ToolRegistry.js';
import { searchTools } from '../search/toolSearch.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';

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

/**
 * The read-only surface that ToolExposurePlanner (and other consumers)
 * depend on.  Both ToolCatalog and ToolRegistry satisfy this shape,
 * so LoopRunner can pass whichever is available without duck-typing.
 */
export interface ToolCatalogReadView {
  getAll(): Tool[];
  getEntries?(): ToolCatalogEntry[];
  getFunctionDeclarationsByMode?(mode?: PermissionMode): FunctionDeclaration[];
}

function matchesMcpServer(tool: Tool, serverName: string): boolean {
  const legacyPrefix = `mcp__${serverName}__`;
  return tool.tags.includes(serverName) || tool.name.startsWith(legacyPrefix);
}

export class ToolCatalog implements ToolCatalogReadView {
  private readonly entries = new Map<string, ToolCatalogEntry>();

  constructor(private readonly registry = new ToolRegistry()) {}

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  register<TParams>(tool: Tool<TParams>, source: ToolSourceInfo = {
    kind: 'custom',
    trustLevel: 'workspace',
    sourceId: 'custom',
  }): void {
    this.registry.register(tool as unknown as Tool);
    this.entries.set(tool.name, { tool: tool as unknown as Tool, source });
  }

  registerAll<TParams>(tools: Tool<TParams>[], source: ToolSourceInfo = {
    kind: 'custom',
    trustLevel: 'workspace',
    sourceId: 'custom',
  }): void {
    for (const tool of tools) {
      this.register(tool, source);
    }
  }

  registerMcpTool<TParams>(tool: Tool<TParams>, source: ToolSourceInfo = {
    kind: 'mcp',
    trustLevel: 'remote',
    sourceId: 'mcp',
  }): void {
    this.registry.registerMcpTool(tool as unknown as Tool);
    this.entries.set(tool.name, { tool: tool as unknown as Tool, source });
  }

  unregister(name: string): boolean {
    const tool = this.registry.get(name);
    const removed = this.registry.unregister(name);
    if (removed && tool) {
      this.entries.delete(tool.name);
    }
    return removed;
  }

  removeMcpTools(serverName: string): number {
    const removedNames = this.registry.getMcpTools()
      .filter((tool) => matchesMcpServer(tool, serverName))
      .map((tool) => tool.name);
    const removedCount = this.registry.removeMcpTools(serverName);
    for (const name of removedNames) {
      this.entries.delete(name);
    }
    return removedCount;
  }

  get(name: string): Tool | undefined {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  getAll(): Tool[] {
    return this.registry.getAll();
  }

  getEntries(): ToolCatalogEntry[] {
    return this.registry.getAll()
      .map((tool) => this.entries.get(tool.name))
      .filter((entry): entry is ToolCatalogEntry => Boolean(entry));
  }

  getEntry(name: string): ToolCatalogEntry | undefined {
    const tool = this.registry.get(name);
    return tool ? this.entries.get(tool.name) : undefined;
  }

  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.registry.getFunctionDeclarations();
  }

  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[] {
    return this.registry.getFunctionDeclarationsByMode(mode);
  }

  search(query: string): Tool[] {
    return searchTools(this.getAll(), query);
  }
}
