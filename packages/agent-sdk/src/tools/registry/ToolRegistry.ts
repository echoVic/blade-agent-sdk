import { PermissionMode } from '../../types/common.js';
import { getErrorMessage } from '@blade-ai/agent/utils';
import { searchTools } from '../toolSearch.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';
import { resolveToolBehaviorHint } from '../types/ToolKind.js';

/**
 * 工具注册表
 * 管理内置工具和MCP工具的注册、发现和查询
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();
  private aliases = new Map<string, string>();
  private categories = new Map<string, Set<string>>();
  private tags = new Map<string, Set<string>>();
  private sortedAllToolsCache?: Tool[];
  private sortedBuiltinToolsCache?: Tool[];
  private sortedMcpToolsCache?: Tool[];

  /**
   * 注册内置工具
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 '${tool.name}' 已注册`);
    }
    this.assertAliasesAvailable(tool);

    this.tools.set(tool.name, tool);
    this.registerAliases(tool);
    this.updateIndexes(tool);
    this.invalidateSortedToolCaches();
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: Tool[]): void {
    const errors: string[] = [];

    for (const tool of tools) {
      try {
        this.register(tool);
      } catch (error) {
        errors.push(`${tool.name}: ${getErrorMessage(error)}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`批量注册失败: ${errors.join(', ')}`);
    }
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    const builtinTool = this.tools.get(name);
    if (builtinTool) {
      this.tools.delete(name);
      this.unregisterAliases(builtinTool);
      this.removeFromIndexes(builtinTool);
      this.invalidateSortedToolCaches();

      return true;
    }

    const canonicalName = this.aliases.get(name) || name;
    const mcpTool = this.mcpTools.get(canonicalName);
    if (!mcpTool) {
      return false;
    }

    this.mcpTools.delete(canonicalName);
    this.unregisterAliases(mcpTool);
    this.removeFromIndexes(mcpTool);
    this.invalidateSortedToolCaches();
    return true;
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    const canonicalName = this.aliases.get(name) || name;
    return this.tools.get(canonicalName) || this.mcpTools.get(canonicalName);
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    const canonicalName = this.aliases.get(name) || name;
    return this.tools.has(canonicalName) || this.mcpTools.has(canonicalName);
  }

  /**
   * 获取所有工具
   */
  getAll(): Tool[] {
    if (!this.sortedAllToolsCache) {
      this.sortedAllToolsCache = this.getSortedTools([
        ...Array.from(this.tools.values()),
        ...Array.from(this.mcpTools.values()),
      ]);
    }
    return [...this.sortedAllToolsCache];
  }

  /**
   * 获取内置工具
   */
  getBuiltinTools(): Tool[] {
    if (!this.sortedBuiltinToolsCache) {
      this.sortedBuiltinToolsCache = this.getSortedTools(Array.from(this.tools.values()));
    }
    return [...this.sortedBuiltinToolsCache];
  }

  /**
   * 获取MCP工具
   */
  getMcpTools(): Tool[] {
    if (!this.sortedMcpToolsCache) {
      this.sortedMcpToolsCache = this.getSortedTools(Array.from(this.mcpTools.values()));
    }
    return [...this.sortedMcpToolsCache];
  }

  /**
   * 按分类获取工具
   */
  getByCategory(category: string): Tool[] {
    const toolNames = this.categories.get(category);
    if (!toolNames) {
      return [];
    }

    return Array.from(toolNames)
      .map((name) => this.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }

  /**
   * 按标签获取工具
   */
  getByTag(tag: string): Tool[] {
    const toolNames = this.tags.get(tag);
    if (!toolNames) {
      return [];
    }

    return Array.from(toolNames)
      .map((name) => this.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }

  /**
   * 搜索工具
   */
  search(query: string): Tool[] {
    return searchTools(this.getAll(), query);
  }

  /**
   * 获取工具函数声明
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 根据权限模式获取函数声明
   */
  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[] {
    const tools = this.getAll();
    const declarations: FunctionDeclaration[] = [];

    for (const tool of tools) {
      const behavior = resolveToolBehaviorHint(tool);

      if (mode === undefined || mode === PermissionMode.DEFAULT) {
        declarations.push(tool.getFunctionDeclaration());
        continue;
      }

      if (mode === PermissionMode.AUTO_EDIT) {
        if (!behavior.isDestructive) {
          declarations.push(tool.getFunctionDeclaration());
        }
        continue;
      }

      if (mode === PermissionMode.YOLO) {
        declarations.push(tool.getFunctionDeclaration());
        continue;
      }

      if (mode === PermissionMode.PLAN) {
        // PLAN 模式仅暴露只读工具（防止 LLM 尝试调用被拒工具）
        if (behavior.isReadOnly) {
          declarations.push(tool.getFunctionDeclaration());
        }
      }
    }

    return declarations;
  }

  /**
   * 注册MCP工具
   */
  registerMcpTool(tool: Tool): void {
    if (this.mcpTools.has(tool.name)) {
      throw new Error(`工具 '${tool.name}' 已注册`);
    }
    this.assertAliasesAvailable(tool, 'mcp');

    this.mcpTools.set(tool.name, tool);
    this.registerAliases(tool);
    this.updateIndexes(tool);
    this.invalidateSortedToolCaches();
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    totalTools: number;
    builtinTools: number;
    mcpTools: number;
    categories: number;
    tags: number;
    toolsByCategory: Record<string, number>;
  } {
    const toolsByCategory: Record<string, number> = {};
    for (const [category, toolNames] of this.categories) {
      toolsByCategory[category] = toolNames.size;
    }

    return {
      totalTools: this.getAll().length,
      builtinTools: this.tools.size,
      mcpTools: this.mcpTools.size,
      categories: this.categories.size,
      tags: this.tags.size,
      toolsByCategory,
    };
  }

  /**
   * 获取排序后的工具列表（内置工具优先，MCP工具在后）
   */
  private getSortedTools(tools: Tool[]): Tool[] {
    return [...tools].sort((left, right) => {
      const leftIsMcp = this.mcpTools.has(left.name);
      const rightIsMcp = this.mcpTools.has(right.name);
      if (leftIsMcp !== rightIsMcp) {
        return leftIsMcp ? 1 : -1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  private invalidateSortedToolCaches(): void {
    this.sortedAllToolsCache = undefined;
    this.sortedBuiltinToolsCache = undefined;
    this.sortedMcpToolsCache = undefined;
  }

  /**
   * 移除MCP工具（通过名称前缀匹配）
   */
  removeMcpTools(serverName: string): number {
    let removedCount = 0;
    const legacyPrefix = `mcp__${serverName}__`;

    for (const [name, tool] of this.mcpTools.entries()) {
      if (tool.tags.includes(serverName) || name.startsWith(legacyPrefix)) {
        this.mcpTools.delete(name);
        this.unregisterAliases(tool);
        this.removeFromIndexes(tool);
        this.invalidateSortedToolCaches();
        removedCount++;
      }
    }

    return removedCount;
  }

  /**
   * 更新索引
   */
  private updateIndexes(tool: Tool): void {
    // 更新分类索引
    if (tool.category) {
      let categorySet = this.categories.get(tool.category);
      if (!categorySet) {
        categorySet = new Set();
        this.categories.set(tool.category, categorySet);
      }
      categorySet.add(tool.name);
    }

    // 更新标签索引
    for (const tag of tool.tags) {
      let tagSet = this.tags.get(tag);
      if (!tagSet) {
        tagSet = new Set();
        this.tags.set(tag, tagSet);
      }
      tagSet.add(tool.name);
    }
  }

  /**
   * 从索引中移除
   */
  private removeFromIndexes(tool: Tool): void {
    // 从分类索引移除
    if (tool.category) {
      const categorySet = this.categories.get(tool.category);
      if (categorySet) {
        categorySet.delete(tool.name);
        if (categorySet.size === 0) {
          this.categories.delete(tool.category);
        }
      }
    }

    // 从标签索引移除
    for (const tag of tool.tags) {
      const tagSet = this.tags.get(tag);
      if (tagSet) {
        tagSet.delete(tool.name);
        if (tagSet.size === 0) {
          this.tags.delete(tag);
        }
      }
    }
  }

  private assertAliasesAvailable(tool: Tool, namespace: 'builtin' | 'mcp' = 'builtin'): void {
    for (const alias of tool.aliases ?? []) {
      const existingAliasTarget = this.aliases.get(alias);
      if (existingAliasTarget && existingAliasTarget !== tool.name) {
        throw new Error(`工具别名 '${alias}' 已被 '${existingAliasTarget}' 使用`);
      }

      const builtinConflict = this.tools.get(alias);
      if (builtinConflict && builtinConflict.name !== tool.name) {
        throw new Error(`工具别名 '${alias}' 与已注册工具 '${builtinConflict.name}' 冲突`);
      }

      const mcpConflict = this.mcpTools.get(alias);
      if (mcpConflict && mcpConflict.name !== tool.name) {
        throw new Error(`工具别名 '${alias}' 与已注册工具 '${mcpConflict.name}' 冲突`);
      }

      if (alias === tool.name) {
        throw new Error(`工具别名 '${alias}' 不能与主名称相同`);
      }

      if (namespace === 'builtin' && this.mcpTools.has(alias)) {
        throw new Error(`工具别名 '${alias}' 与已注册 MCP 工具冲突`);
      }

      if (namespace === 'mcp' && this.tools.has(alias)) {
        throw new Error(`工具别名 '${alias}' 与已注册内置工具冲突`);
      }
    }
  }

  private registerAliases(tool: Tool): void {
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
  }

  private unregisterAliases(tool: Tool): void {
    for (const alias of tool.aliases ?? []) {
      if (this.aliases.get(alias) === tool.name) {
        this.aliases.delete(alias);
      }
    }
  }
}

/**
 * 注册表统计信息
 */
export interface RegistryStats {
  totalTools: number;
  builtinTools: number;
  mcpTools: number;
  categories: number;
  tags: number;
  toolsByCategory: Record<string, number>;
}
