import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { SubagentConfig, SubagentFrontmatter, SubagentSource } from './types.js';
import { mapClaudeCodePermissionMode } from './types.js';

type ConfigSource = 'builtin' | 'user' | 'project' | 'session' | 'plugin';
type FileConfigSource = Exclude<ConfigSource, 'plugin' | 'session'>;

const builtinAgents: SubagentConfig[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
    tools: [],
  },
  {
    name: 'Explore',
    description:
      'Fast agent specialized for exploring codebases, finding files, searching code, and answering codebase questions.',
    tools: ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'],
    omitEnvironment: true,
    systemPrompt:
      'You are a specialized code exploration agent. Execute searches directly and return one concise, comprehensive message.',
  },
  {
    name: 'Plan',
    description:
      'Software architect agent for designing implementation plans, identifying critical files, and considering trade-offs.',
    tools: [],
    omitEnvironment: true,
    systemPrompt:
      'You are a software architect specializing in implementation planning. Return actionable steps, critical files, risks, and trade-offs.',
  },
];

interface LoggerLike {
  child?(category: unknown): LoggerLike;
  warn?(message: string, error?: unknown): void;
  debug?(message: string): void;
}

export class SubagentRegistry {
  private readonly subagents = new Map<string, SubagentConfig>();
  private logger?: LoggerLike;

  constructor(logger?: LoggerLike, private projectDir?: string) {
    this.logger = logger?.child ? logger.child('agent') : logger;
  }

  setLogger(logger: LoggerLike): void {
    this.logger = logger.child ? logger.child('agent') : logger;
  }

  setProjectDir(projectDir?: string): void {
    this.projectDir = projectDir;
  }

  register(config: SubagentConfig, options?: { override?: boolean }): void {
    if (!options?.override && this.subagents.has(config.name)) {
      throw new Error(`Subagent '${config.name}' already registered`);
    }
    this.subagents.set(config.name, config);
  }

  getSubagent(name: string): SubagentConfig | undefined {
    return this.subagents.get(name);
  }

  getAllNames(): string[] {
    return [...this.subagents.keys()];
  }

  getAllSubagents(): SubagentConfig[] {
    return [...this.subagents.values()];
  }

  getDescriptionsForPrompt(): string {
    const subagents = this.getAllSubagents();
    if (subagents.length === 0) {
      return 'No subagents available.';
    }

    const descriptions = subagents.map((config) => {
      const tools = !config.tools || config.tools.length === 0
        ? 'All tools'
        : config.tools.join(', ');
      return `- ${config.name}: ${config.description} (Tools: ${tools})`;
    });

    return `Available agent types and the tools they have access to:\n${descriptions.join('\n')}`;
  }

  loadFromDirectory(dirPath: string, source?: FileConfigSource): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(dirPath, file);
      try {
        this.register(this.parseConfigFile(filePath, source), { override: true });
      } catch (error) {
        this.logger?.warn?.(`Failed to load subagent config from ${filePath}:`, error);
      }
    }
  }

  loadFromStandardLocations(
    projectDir: string | undefined = this.projectDir,
    storageRoot?: string,
  ): number {
    this.loadBuiltinAgents();

    if (storageRoot) {
      this.loadFromDirectory(path.join(storageRoot, 'agents'), 'user');
    }

    if (projectDir) {
      this.loadFromDirectory(path.join(projectDir, 'agents'), 'project');
    }

    const count = this.getAllNames().length;
    this.logger?.debug?.(`Loaded ${count} subagents from standard locations`);
    return count;
  }

  loadBuiltinAgents(): void {
    for (const agent of builtinAgents) {
      this.register({
        ...agent,
        model: agent.model || 'inherit',
        source: 'builtin',
      }, { override: true });
    }
    this.logger?.debug?.(`Loaded ${builtinAgents.length} builtin subagents`);
  }

  clear(): void {
    this.subagents.clear();
  }

  getSubagentsBySource(): Record<ConfigSource, SubagentConfig[]> {
    const result: Record<ConfigSource, SubagentConfig[]> = {
      builtin: [],
      user: [],
      project: [],
      session: [],
      plugin: [],
    };

    for (const config of this.subagents.values()) {
      const source: SubagentSource = config.source || 'builtin';
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

  clearPluginAgents(): void {
    for (const [name, config] of this.subagents.entries()) {
      if (config.source?.startsWith('plugin:')) {
        this.subagents.delete(name);
      }
    }
  }

  private parseConfigFile(filePath: string, source?: FileConfigSource): SubagentConfig {
    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      throw new Error(`No YAML frontmatter found in ${filePath}`);
    }

    const [, frontmatterYaml, markdownContent] = frontmatterMatch;
    const frontmatter = yaml.parse(frontmatterYaml) as SubagentFrontmatter;

    if (!frontmatter.name || !frontmatter.description) {
      throw new Error(`Missing required fields (name, description) in ${filePath}`);
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: markdownContent.trim(),
      tools: parseStringOrArray(frontmatter.tools),
      color: frontmatter.color,
      configPath: filePath,
      model: frontmatter.model || 'inherit',
      permissionMode: mapClaudeCodePermissionMode(frontmatter.permissionMode),
      skills: parseStringOrArray(frontmatter.skills),
      source,
    };
  }
}

function parseStringOrArray(value: string | string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const subagentRegistry = new SubagentRegistry();
