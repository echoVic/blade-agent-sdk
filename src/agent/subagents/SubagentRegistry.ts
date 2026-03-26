import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { builtinAgents } from './builtinAgents.js';
import type { SubagentConfig, SubagentFrontmatter } from './types.js';
import { mapClaudeCodePermissionMode } from './types.js';

/**
 * 配置来源类型
 */
type ConfigSource =
  | 'builtin'
  | 'user'
  | 'project'
  | 'plugin';

type FileConfigSource = Exclude<ConfigSource, 'plugin'>;

/**
 * Subagent 注册表
 *
 * 职责：
 * - 注册和发现 subagents
 * - 解析 Markdown + YAML frontmatter 配置
 * - 生成 LLM 可读的描述
 */
export class SubagentRegistry {
  private subagents = new Map<string, SubagentConfig>();
  private logger: InternalLogger;
  private projectDir?: string;

  constructor(logger: InternalLogger = NOOP_LOGGER, projectDir?: string) {
    this.logger = logger.child(LogCategory.AGENT);
    this.projectDir = projectDir;
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
  }

  setProjectDir(projectDir?: string): void {
    this.projectDir = projectDir;
  }

  /**
   * 注册一个 subagent
   * @param config - 子代理配置
   */
  register(config: SubagentConfig): void {
    if (this.subagents.has(config.name)) {
      throw new Error(`Subagent '${config.name}' already registered`);
    }
    this.subagents.set(config.name, config);
  }

  /**
   * 获取指定 subagent
   */
  getSubagent(name: string): SubagentConfig | undefined {
    return this.subagents.get(name);
  }

  /**
   * 获取所有 subagent 名称
   */
  getAllNames(): string[] {
    return Array.from(this.subagents.keys());
  }

  /**
   * 获取所有 subagent 配置
   */
  getAllSubagents(): SubagentConfig[] {
    return Array.from(this.subagents.values());
  }

  /**
   * 生成 LLM 可读的 subagent 描述（用于系统提示）
   */
  getDescriptionsForPrompt(): string {
    const subagents = this.getAllSubagents();
    if (subagents.length === 0) {
      return 'No subagents available.';
    }

    const descriptions = subagents.map((config) => {
      // 工具列表：空数组表示所有工具
      const toolsStr =
        !config.tools || config.tools.length === 0
          ? 'All tools'
          : config.tools.join(', ');

      return `- ${config.name}: ${config.description} (Tools: ${toolsStr})`;
    });

    return `Available agent types and the tools they have access to:\n${descriptions.join('\n')}`;
  }

  /**
   * 从目录加载所有 subagent 配置文件
   * @param dirPath - 配置文件目录
   * @param source - 配置来源（用于调试和优先级追踪）
   */
  loadFromDirectory(dirPath: string, source?: FileConfigSource): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(dirPath, file);
      try {
        const config = this.parseConfigFile(filePath, source);
        // 使用 set 允许覆盖（用户/项目配置覆盖内置）
        this.subagents.set(config.name, config);
      } catch (error) {
        this.logger.warn(`Failed to load subagent config from ${filePath}:`, error);
      }
    }
  }

  /**
   * 解析 Markdown + YAML frontmatter 配置文件
   *
   * 兼容 Claude Code 官方格式：
   * - tools 支持逗号分隔字符串或数组
   * - model 支持 sonnet/opus/haiku 或 'inherit'
   * - permissionMode 支持权限模式
   * - skills 支持自动加载的 skills
   */
  private parseConfigFile(filePath: string, source?: FileConfigSource): SubagentConfig {
    const content = fs.readFileSync(filePath, 'utf-8');

    // 解析 YAML frontmatter（支持 \r\n 和 \n）
    const frontmatterMatch = content.match(
      /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
    );
    if (!frontmatterMatch) {
      throw new Error(`No YAML frontmatter found in ${filePath}`);
    }

    const [, frontmatterYaml, markdownContent] = frontmatterMatch;
    const frontmatter = yaml.parse(frontmatterYaml) as SubagentFrontmatter;

    // 验证必需字段
    if (!frontmatter.name || !frontmatter.description) {
      throw new Error(`Missing required fields (name, description) in ${filePath}`);
    }

    // 使用 Markdown 内容作为系统提示
    const systemPrompt = markdownContent.trim();

    // 解析 tools（支持逗号分隔字符串或数组）
    const tools = this.parseStringOrArray(frontmatter.tools);

    // 解析 skills（支持逗号分隔字符串或数组）
    const skills = this.parseStringOrArray(frontmatter.skills);

    // 映射 permissionMode（Claude Code → Blade）
    const permissionMode = mapClaudeCodePermissionMode(frontmatter.permissionMode);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt,
      tools,
      color: frontmatter.color,
      configPath: filePath,
      model: frontmatter.model || 'inherit', // 默认继承父 Agent 模型
      permissionMode,
      skills,
      source,
    };
  }

  /**
   * 解析逗号分隔字符串或数组为字符串数组
   * @param value - 逗号分隔字符串或数组
   * @returns 字符串数组，如果输入为空则返回 undefined
   */
  private parseStringOrArray(
    value: string | string[] | undefined
  ): string[] | undefined {
    if (!value) {
      return undefined;
    }

    if (Array.isArray(value)) {
      return value.map((s) => s.trim()).filter(Boolean);
    }

    // 逗号分隔字符串
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * 从标准位置加载所有 subagent 配置
   *
   * 按优先级加载（后加载的会覆盖前面的）：
   * 1. 内置配置（builtinAgents.ts）
   * 2. 用户级配置（{storageRoot}/agents/）
   * 3. 项目级配置（{projectDir}/agents/ 或 {projectDir}/.agents/）
   *
   * @param projectDir 项目目录（用于加载项目级配置）
   * @param storageRoot SDK 数据存储根目录（用于加载用户级配置）
   * @returns 加载的 subagent 数量
   */
  loadFromStandardLocations(
    projectDir: string | undefined = this.projectDir,
    storageRoot?: string
  ): number {
    // 1. 加载内置配置
    this.loadBuiltinAgents();

    // 2. 加载用户级配置（可覆盖内置）
    if (storageRoot) {
      const userAgentsDir = path.join(storageRoot, 'agents');
      this.loadFromDirectory(userAgentsDir, 'user');
    }

    // 3. 加载项目级配置（可覆盖用户级）
    if (projectDir) {
      const projectAgentsDir = path.join(projectDir, 'agents');
      this.loadFromDirectory(projectAgentsDir, 'project');
    }

    const count = this.getAllNames().length;
    this.logger.debug(`📦 Loaded ${count} subagents from standard locations`);

    return count;
  }

  /**
   * 加载内置 subagent 配置
   */
  loadBuiltinAgents(): void {
    for (const agent of builtinAgents) {
      // 使用 set 而非 register，允许被后续配置覆盖
      this.subagents.set(agent.name, {
        ...agent,
        model: agent.model || 'inherit', // 默认继承父 Agent 模型
        source: 'builtin',
      });
    }
    this.logger.debug(`Loaded ${builtinAgents.length} builtin subagents`);
  }

  /**
   * 清空所有注册的 subagents（用于测试）
   */
  clear(): void {
    this.subagents.clear();
  }

  /**
   * 获取按来源分组的 subagents
   * 用于 UI 展示和调试
   */
  getSubagentsBySource(): Record<ConfigSource, SubagentConfig[]> {
    const result: Record<ConfigSource, SubagentConfig[]> = {
      builtin: [],
      user: [],
      project: [],
      plugin: [],
    };

    for (const config of this.subagents.values()) {
      const source = config.source || 'builtin';
      // Map plugin:xxx sources to 'plugin' category
      const category: ConfigSource = source.startsWith('plugin:')
        ? 'plugin'
        : (source as ConfigSource);
      if (category in result) {
        result[category].push(config);
      } else {
        result.builtin.push(config);
      }
    }

    return result;
  }

  /**
   * 清除所有插件代理
   * Called when refreshing plugins
   */
  clearPluginAgents(): void {
    const toDelete: string[] = [];
    for (const [name, config] of this.subagents.entries()) {
      if (config.source?.startsWith('plugin:')) {
        toDelete.push(name);
      }
    }
    for (const name of toDelete) {
      this.subagents.delete(name);
    }
  }
}

/**
 * 全局单例
 */
export const subagentRegistry = new SubagentRegistry();
