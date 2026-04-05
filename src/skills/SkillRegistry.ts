/**
 * SkillRegistry - Skill 注册表
 *
 * 负责发现、加载、管理所有可用的 Skills。
 * 使用 Progressive Disclosure：启动时仅加载元数据，执行时才加载完整内容。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { filterSkillsByActivation } from './activation.js';
import { defaultSkillSource, type SkillSource, type SkillSourceConfig } from './types.js';
import { hasSkillFile, loadSkillContent, loadSkillMetadata } from './SkillLoader.js';
import type {
  SkillActivationContext,
  SkillContent,
  SkillDiscoveryResult,
  SkillMetadata,
  SkillRegistryConfig,
} from './types.js';

type ResolvedSkillRegistryConfig =
  Omit<SkillRegistryConfig, 'cwd'> & { cwd?: string };

interface RegisteredSource {
  descriptor: SkillSource;
  directory: string;
}

const DEFAULT_CONFIG: ResolvedSkillRegistryConfig = {
  projectSkillsDir: 'skills',
  additionalSources: [],
};

let instance: SkillRegistry | null = null;

export class SkillRegistry {
  private skills: Map<string, SkillMetadata> = new Map();
  private config: ResolvedSkillRegistryConfig;
  private initialized = false;

  constructor(config?: SkillRegistryConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: SkillRegistryConfig): SkillRegistry {
    if (!instance) {
      instance = new SkillRegistry(config);
    }
    return instance;
  }

  static resetInstance(): void {
    instance = null;
  }

  async initialize(): Promise<SkillDiscoveryResult> {
    if (this.initialized) {
      return {
        skills: Array.from(this.skills.values()),
        errors: [],
      };
    }

    const errors: SkillDiscoveryResult['errors'] = [];
    const byCanonicalPath = new Map<string, SkillMetadata>();

    for (const source of this.resolveSources()) {
      const result = await this.scanDirectory(source);
      errors.push(...result.errors);

      for (const skill of result.skills) {
        const canonicalPath = await this.resolveCanonicalPath(skill.path);
        if (!canonicalPath) {
          continue;
        }

        const existing = byCanonicalPath.get(canonicalPath);
        if (!existing || skill.source.precedence >= existing.source.precedence) {
          byCanonicalPath.set(canonicalPath, skill);
        }
      }
    }

    const discoveredCandidates = Array.from(byCanonicalPath.values());
    discoveredCandidates.sort((left, right) => left.source.precedence - right.source.precedence);

    for (const skill of discoveredCandidates) {
      const existing = this.skills.get(skill.name);
      if (!existing || skill.source.precedence >= existing.source.precedence) {
        this.skills.set(skill.name, skill);
      }
    }

    this.initialized = true;

    return {
      skills: Array.from(this.skills.values()),
      errors,
    };
  }

  private resolveSources(): RegisteredSource[] {
    const sources: RegisteredSource[] = [];

    if (this.config.userSkillsDir) {
      sources.push({
        descriptor: defaultSkillSource('user', this.config.userSkillsDir),
        directory: this.config.userSkillsDir,
      });
    }

    if (this.config.cwd && this.config.projectSkillsDir) {
      const projectDir = path.isAbsolute(this.config.projectSkillsDir)
        ? this.config.projectSkillsDir
        : path.join(this.config.cwd, this.config.projectSkillsDir);
      sources.push({
        descriptor: defaultSkillSource('project', projectDir),
        directory: projectDir,
      });
    }

    for (const source of this.config.additionalSources ?? []) {
      sources.push(this.toRegisteredSource(source));
    }

    return sources.sort((left, right) => left.descriptor.precedence - right.descriptor.precedence);
  }

  private toRegisteredSource(source: SkillSourceConfig): RegisteredSource {
    return {
      descriptor: defaultSkillSource(source.kind, source.directory, {
        precedence: source.precedence,
        trustLevel: source.trustLevel,
        shellPolicy: source.shellPolicy,
        hookPolicy: source.hookPolicy,
        sourceId: source.sourceId ?? source.kind,
      }),
      directory: source.directory,
    };
  }

  private async resolveCanonicalPath(filePath: string): Promise<string | null> {
    try {
      return await fs.realpath(filePath);
    } catch {
      return null;
    }
  }

  private async scanDirectory(source: RegisteredSource): Promise<SkillDiscoveryResult> {
    const skills: SkillMetadata[] = [];
    const errors: SkillDiscoveryResult['errors'] = [];

    try {
      await fs.access(source.directory);
    } catch {
      return { skills, errors };
    }

    try {
      const entries = await fs.readdir(source.directory, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(source.directory, entry.name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (!(await hasSkillFile(skillDir))) continue;

        const result = await loadSkillMetadata(skillFile, {
          ...source.descriptor,
          rootDir: source.directory,
        });
        if (result.success && result.content) {
          skills.push(result.content.metadata);
        } else {
          errors.push({
            path: skillFile,
            error: result.error || 'Unknown error',
          });
        }
      }
    } catch (e) {
      errors.push({
        path: source.directory,
        error: `Failed to scan directory: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    return { skills, errors };
  }

  getAll(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  async loadContent(
    name: string,
    options?: Parameters<typeof loadSkillContent>[1],
  ): Promise<SkillContent | null> {
    const metadata = this.skills.get(name);
    if (!metadata) return null;
    return loadSkillContent(metadata, options);
  }

  getModelInvocableSkills(context?: SkillActivationContext): SkillMetadata[] {
    const modelInvocableSkills = Array.from(this.skills.values()).filter(
      (skill) => !skill.disableModelInvocation,
    );
    return filterSkillsByActivation(modelInvocableSkills, context);
  }

  getUserInvocableSkills(context?: SkillActivationContext): SkillMetadata[] {
    const userInvocableSkills = Array.from(this.skills.values()).filter(
      (skill) => skill.userInvocable === true,
    );
    return filterSkillsByActivation(userInvocableSkills, context);
  }

  generateAvailableSkillsList(context?: SkillActivationContext): string {
    const modelInvocableSkills = this.getModelInvocableSkills(context);
    if (modelInvocableSkills.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const skill of modelInvocableSkills) {
      const desc =
        skill.description.length > 100
          ? `${skill.description.substring(0, 97)}...`
          : skill.description;
      const nameWithHint = skill.argumentHint
        ? `${skill.name} ${skill.argumentHint}`
        : skill.name;
      lines.push(`- ${nameWithHint}: ${desc}`);
    }

    return lines.join('\n');
  }

  get size(): number {
    return this.skills.size;
  }

  async refresh(): Promise<SkillDiscoveryResult> {
    this.skills.clear();
    this.initialized = false;
    return this.initialize();
  }
}

export function getSkillRegistry(config?: SkillRegistryConfig): SkillRegistry {
  return SkillRegistry.getInstance(config);
}

export async function discoverSkills(
  config?: SkillRegistryConfig,
): Promise<SkillDiscoveryResult> {
  const registry = getSkillRegistry(config);
  return registry.initialize();
}
