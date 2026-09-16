import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { builtinAgents } from './builtinAgents.js';
import type { SubagentConfig, SubagentFrontmatter } from './types.js';
import { mapClaudeCodePermissionMode } from './types.js';

type FileConfigSource = 'builtin' | 'user' | 'project';

export class SubagentRegistry {
  private readonly subagents = new Map<string, SubagentConfig>();
  private logger: InternalLogger;

  constructor(
    logger: InternalLogger = NOOP_LOGGER,
    private projectDir?: string,
  ) {
    this.logger = logger.child(LogCategory.AGENT);
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
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

  loadFromStandardLocations(
    projectDir: string | undefined = this.projectDir,
    storageRoot?: string,
  ): number {
    this.loadBuiltinAgents();
    if (!projectDir) return this.subagents.size;
    if (storageRoot) this.loadFromDirectory(path.join(storageRoot, 'agents'), 'user');
    this.loadFromDirectory(path.join(projectDir, 'agents'), 'project');
    this.logger.debug(`📦 Loaded ${this.subagents.size} subagents from standard locations`);
    return this.subagents.size;
  }

  loadBuiltinAgents(): void {
    for (const agent of builtinAgents) {
      this.register(
        { ...agent, model: agent.model || 'inherit', source: 'builtin' },
        {
          override: true,
        },
      );
    }
  }

  loadFromDirectory(directory: string, source: FileConfigSource): void {
    if (!fs.existsSync(directory)) return;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(directory, file);
      try {
        this.register(this.parseFile(filePath, source), { override: true });
      } catch (error) {
        this.logger.warn(`Failed to load subagent config from ${filePath}:`, error);
      }
    }
  }

  private parseFile(filePath: string, source: FileConfigSource): SubagentConfig {
    const match = fs
      .readFileSync(filePath, 'utf8')
      .match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error(`No YAML frontmatter found in ${filePath}`);
    const frontmatter = yaml.parse(match[1]) as SubagentFrontmatter;
    if (!frontmatter.name || !frontmatter.description) {
      throw new Error(`Missing required fields (name, description) in ${filePath}`);
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: match[2].trim(),
      tools: this.stringList(frontmatter.tools),
      color: frontmatter.color,
      configPath: filePath,
      model: frontmatter.model || 'inherit',
      permissionMode: mapClaudeCodePermissionMode(frontmatter.permissionMode),
      skills: this.stringList(frontmatter.skills),
      source,
    };
  }

  private stringList(value: string | string[] | undefined): string[] | undefined {
    if (!value) return undefined;
    return (Array.isArray(value) ? value : value.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}
