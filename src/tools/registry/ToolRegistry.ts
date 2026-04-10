import { PermissionMode } from '../../types/common.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import { searchTools } from '../search/toolSearch.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';
import { resolveToolBehaviorHint } from '../types/index.js';

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
   * 获取函数声明（用于LLM）
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 获取只读工具的函数声明（用于 Plan 模式）
   * Plan 模式下只允许使用只读工具：Read, Glob, Grep, WebFetch, WebSearch, Task, EnterPlanMode, ExitPlanMode, TodoWrite
   */
  getReadOnlyFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll()
      .filter((tool) => resolveToolBehaviorHint(tool).isReadOnly)
      .map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 根据权限模式获取函数声明（单一信息源）
   *
   * 工具暴露策略：
   * - PLAN 模式：仅暴露只读工具（防止 LLM 尝试调用被拒工具）
   * - DEFAULT/AUTO_EDIT/YOLO 模式：暴露全量工具（实际权限由 ExecutionPipeline 统一决策）
   *
   * 这确保了工具暴露策略和执行期权限检查使用相同的模式值，
   * 避免了 LLM 看到工具但执行被拒的循环问题。
   *
   * @param mode - 权限模式
   * @returns 对应模式下可用的函数声明列表
   */
  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[] {
    // Plan 模式：仅暴露只读工具
    if (mode === PermissionMode.PLAN) {
      return this.getReadOnlyFunctionDeclarations();
    }

    // 其他模式（default/autoEdit/yolo）：暴露全量工具
    // 具体执行权限由 ExecutionPipeline 根据 permissionMode 进行细粒度控制
    return this.getFunctionDeclarations();
  }

  /**
   * 获取只读工具
   */
  getReadOnlyTools(): Tool[] {
    return this.getAll().filter((tool) => resolveToolBehaviorHint(tool).isReadOnly);
  }

  /**
   * 获取所有分类
   */
  getCategories(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * 获取所有标签
   */
  getTags(): string[] {
    return Array.from(this.tags.keys());
  }

  /**
   * 获取统计信息
   */
  getStats(): RegistryStats {
    return {
      totalTools: this.tools.size + this.mcpTools.size,
      builtinTools: this.tools.size,
      mcpTools: this.mcpTools.size,
      categories: this.categories.size,
      tags: this.tags.size,
      toolsByCategory: Object.fromEntries(
        Array.from(this.categories.entries()).map(([cat, tools]) => [cat, tools.size])
      ),
    };
  }

  /**
   * 注册MCP工具
   */
  registerMcpTool(tool: Tool): void {
    if (this.mcpTools.has(tool.name)) {
      // MCP工具可以覆盖（支持热更新）
      const previous = this.mcpTools.get(tool.name);
      if (previous) {
        this.unregisterAliases(previous);
      }
      this.mcpTools.delete(tool.name);
    }
    this.assertAliasesAvailable(tool, 'mcp');

    this.mcpTools.set(tool.name, tool);
    this.registerAliases(tool);
    this.updateIndexes(tool);
    this.invalidateSortedToolCaches();
  }

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
