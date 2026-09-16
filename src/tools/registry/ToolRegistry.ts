import { getErrorMessage } from '../../utils/errorUtils.js';
import { isToolSideEffect } from '../behavior.js';
import { toolFromDefinition } from '../core/createTool.js';
import { selectToolServices, type ToolServices } from '../services.js';
import type { ErasedToolDefinition, Tool } from '../types/tool.js';

const MCP_TOOL_NAME_PREFIX = 'mcp__';

export type ToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';
export type ToolTrustLevel = 'trusted' | 'workspace' | 'remote';

interface ToolSourceBase {
  readonly trustLevel: ToolTrustLevel;
  readonly sourceId: string;
}

export type ToolSourceInfo =
  | (ToolSourceBase & {
      readonly kind: 'mcp';
      readonly serverName: string;
    })
  | (ToolSourceBase & {
      readonly kind: Exclude<ToolSourceKind, 'mcp'>;
      readonly serverName?: never;
    });

export const BUILTIN_TOOL_SOURCE = Object.freeze({
  kind: 'builtin',
  trustLevel: 'trusted',
  sourceId: 'builtin',
} satisfies ToolSourceInfo);

export interface RegisteredTool {
  readonly tool: Tool;
  readonly source: ToolSourceInfo;
}

export interface ToolSourcePolicy {
  readonly allowedSources?: readonly ToolSourceKind[];
  readonly allowedTrustLevels?: readonly ToolTrustLevel[];
}

interface RegistryEntry extends RegisteredTool {
  readonly services: ToolServices;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegistryEntry>();
  private readonly aliases = new Map<string, string>();
  private sortedEntriesCache?: readonly RegistryEntry[];

  constructor(private readonly services: ToolServices = {}) {}

  registerDefinition(definition: ErasedToolDefinition, source: ToolSourceInfo): Tool | undefined {
    const selection = selectToolServices(this.services, definition.services);
    if (selection.missing.length > 0) {
      return undefined;
    }

    const tool = toolFromDefinition(definition, selection.selected);
    return this.registerCompiled(tool, source, selection.selected) ? tool : undefined;
  }

  register(tool: Tool, source: ToolSourceInfo): boolean {
    const selection = selectToolServices(this.services, tool.services);
    if (selection.missing.length > 0) {
      return false;
    }
    return this.registerCompiled(tool, source, selection.selected);
  }

  registerAll(tools: readonly Tool[], source: ToolSourceInfo): void {
    const errors: string[] = [];
    for (const tool of tools) {
      try {
        this.register(tool, source);
      } catch (error) {
        errors.push(`${tool.name}: ${getErrorMessage(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`批量注册失败: ${errors.join(', ')}`);
    }
  }

  registerMcpTool(tool: Tool, source: Extract<ToolSourceInfo, { kind: 'mcp' }>): boolean {
    const selection = selectToolServices(this.services, tool.services);
    if (selection.missing.length > 0) {
      return false;
    }
    return this.registerCompiled(tool, source, selection.selected);
  }

  unregister(name: string): boolean {
    const canonicalName = this.aliases.get(name) ?? name;
    const entry = this.tools.get(canonicalName);
    if (!entry) {
      return false;
    }
    this.tools.delete(canonicalName);
    this.unregisterAliases(entry.tool);
    this.invalidateCache();
    return true;
  }

  removeMcpTools(serverName: string): number {
    let removedCount = 0;
    for (const [name, entry] of this.tools) {
      if (entry.source.kind !== 'mcp' || entry.source.serverName !== serverName) {
        continue;
      }
      this.tools.delete(name);
      this.unregisterAliases(entry.tool);
      removedCount++;
    }
    if (removedCount > 0) {
      this.invalidateCache();
    }
    return removedCount;
  }

  get(name: string): Tool | undefined {
    return this.getEntry(name)?.tool;
  }

  getEntry(name: string): RegisteredTool | undefined {
    const canonicalName = this.aliases.get(name) ?? name;
    return this.tools.get(canonicalName);
  }

  getServices(name: string): ToolServices {
    const canonicalName = this.aliases.get(name) ?? name;
    return this.tools.get(canonicalName)?.services ?? {};
  }

  has(name: string): boolean {
    return this.getEntry(name) !== undefined;
  }

  getAll(): Tool[] {
    return this.entries().map((entry) => entry.tool);
  }

  entries(): readonly RegisteredTool[] {
    if (!this.sortedEntriesCache) {
      this.sortedEntriesCache = [...this.tools.values()].sort(compareEntries);
    }
    return this.sortedEntriesCache.map(({ tool, source }) => ({ tool, source }));
  }

  private registerCompiled(tool: Tool, source: ToolSourceInfo, services: ToolServices): boolean {
    this.assertSideEffectContract(tool);
    this.assertNamespace(tool, source);

    const existing = this.tools.get(tool.name);
    if (existing) {
      if (source.kind !== 'mcp' || existing.source.kind !== 'mcp') {
        throw new Error(`工具 '${tool.name}' 已注册`);
      }
      this.unregisterAliases(existing.tool);
      this.tools.delete(tool.name);
    }

    this.assertAliasesAvailable(tool);
    this.tools.set(tool.name, { tool, source, services });
    this.registerAliases(tool);
    this.invalidateCache();
    return true;
  }

  private assertNamespace(tool: Tool, source: ToolSourceInfo): void {
    if (source.kind === 'mcp') {
      if (!tool.name.startsWith(MCP_TOOL_NAME_PREFIX)) {
        throw new Error(`MCP 工具 '${tool.name}' 必须使用保留命名空间 ${MCP_TOOL_NAME_PREFIX}`);
      }
      return;
    }
    if (tool.name.startsWith(MCP_TOOL_NAME_PREFIX)) {
      throw new Error(`工具名 '${tool.name}' 使用了保留的 MCP 命名空间`);
    }
  }

  private assertSideEffectContract(tool: Tool): void {
    if (!tool.staticBehavior || !isToolSideEffect(tool.staticBehavior.sideEffect)) {
      throw new TypeError(
        `Tool '${tool.name}' must declare sideEffect as pure, idempotent, or non_idempotent`,
      );
    }
  }

  private assertAliasesAvailable(tool: Tool): void {
    for (const alias of tool.aliases) {
      if (alias === tool.name) {
        throw new Error(`工具别名 '${alias}' 不能与主名称相同`);
      }
      const aliasTarget = this.aliases.get(alias);
      if (aliasTarget && aliasTarget !== tool.name) {
        throw new Error(`工具别名 '${alias}' 已被 '${aliasTarget}' 使用`);
      }
      const nameConflict = this.tools.get(alias);
      if (nameConflict && nameConflict.tool.name !== tool.name) {
        throw new Error(`工具别名 '${alias}' 与已注册工具 '${nameConflict.tool.name}' 冲突`);
      }
    }
  }

  private registerAliases(tool: Tool): void {
    for (const alias of tool.aliases) {
      this.aliases.set(alias, tool.name);
    }
  }

  private unregisterAliases(tool: Tool): void {
    for (const alias of tool.aliases) {
      if (this.aliases.get(alias) === tool.name) {
        this.aliases.delete(alias);
      }
    }
  }

  private invalidateCache(): void {
    this.sortedEntriesCache = undefined;
  }
}

function compareEntries(left: RegistryEntry, right: RegistryEntry): number {
  const leftIsMcp = left.source.kind === 'mcp';
  const rightIsMcp = right.source.kind === 'mcp';
  if (leftIsMcp !== rightIsMcp) {
    return leftIsMcp ? 1 : -1;
  }
  return left.tool.name.localeCompare(right.tool.name);
}
