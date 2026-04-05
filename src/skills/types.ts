import { HookEvent } from '../types/constants.js';

/**
 * Skills 系统类型定义
 *
 * Skills 不再只是 prompt 片段，而是可发现、可编译、可执行的运行时能力包。
 */

export type SkillSourceKind =
  | 'managed'
  | 'user'
  | 'project'
  | 'bundled'
  | 'plugin'
  | 'mcp';

export type SkillTrustLevel = 'trusted' | 'workspace' | 'remote';

export type SkillShellPolicy = 'inherit' | 'allow' | 'deny';

export type SkillHookPolicy = 'inherit' | 'allow' | 'deny';

export type SkillActivationScope = 'turn' | 'session';

export interface SkillSource {
  kind: SkillSourceKind;
  trustLevel: SkillTrustLevel;
  sourceId: string;
  rootDir?: string;
  precedence: number;
  shellPolicy: SkillShellPolicy;
  hookPolicy: SkillHookPolicy;
}

export interface SkillRuntimeEffects {
  allowedTools?: string[];
  deniedTools?: string[];
  modelId?: string;
  effort?: number | string;
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  activeScope?: SkillActivationScope;
}

export interface SkillActivationConditions {
  paths?: string[];
}

export interface SkillActivationContext {
  cwd?: string;
  referencedPaths?: string[];
  args?: string;
}

export interface SkillHookSpec {
  event: HookEvent;
  type: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

export interface SkillShellConfig {
  enabled: boolean;
  allowlist?: string[] | 'all';
}

export interface SkillAssetEntry {
  name: string;
  path: string;
}

export interface SkillAssetManifest {
  scripts: SkillAssetEntry[];
  references: SkillAssetEntry[];
  templates: SkillAssetEntry[];
}

export interface SkillMetadata {
  /** 唯一标识，小写+数字+连字符，≤64字符 */
  name: string;

  /** 激活描述，≤1024字符，包含"什么"和"何时使用" */
  description: string;

  /** 工具访问限制，如 ['Read', 'Grep', 'Bash(git:*)'] */
  allowedTools?: string[];

  /** 工具访问黑名单 */
  disallowedTools?: string[];

  /** 版本号 */
  version?: string;

  /** 参数提示，如 '<file_path>' 或 '<query>' */
  argumentHint?: string;

  /** 是否支持用户通过 /skill-name 命令调用 */
  userInvocable?: boolean;

  /** 是否禁止 AI 自动调用 */
  disableModelInvocation?: boolean;

  /** 指定执行模型 */
  model?: string;

  /** 额外的触发条件描述 */
  whenToUse?: string;

  /** 显式供 runtime 消费的执行效果 */
  runtimeEffects?: SkillRuntimeEffects;

  /** 条件激活规则 */
  conditions?: SkillActivationConditions;

  /** shell 策略 */
  shell?: SkillShellConfig;

  /** 许可证 */
  license?: string;

  /** 环境兼容性说明 */
  compatibility?: string;

  /** 任意元数据键值对 */
  metadata?: Record<string, unknown>;

  /** SKILL.md 文件完整路径 */
  path: string;

  /** Skill 目录路径（用于引用 scripts/templates/references） */
  basePath: string;

  /** 来源信息 */
  source: SkillSource;
}

/**
 * Skill 完整内容（懒加载）
 */
export interface SkillContent {
  metadata: SkillMetadata;

  /** SKILL.md 正文内容（去除 YAML 前置数据后的 Markdown） */
  instructions: string;

  /** 编译后的 skill-level hooks，供 runtime activation 消费 */
  hooks?: SkillHookSpec[];

  /** legacy 兼容：scripts/ 目录下发现的可执行脚本 */
  scripts?: string[];

  /** 完整资产清单 */
  assets: SkillAssetManifest;
}

/**
 * SKILL.md 解析结果
 */
export interface SkillParseResult {
  success: boolean;
  content?: SkillContent;
  error?: string;
}

export interface SkillSourceConfig {
  kind: SkillSourceKind;
  directory: string;
  precedence?: number;
  trustLevel?: SkillTrustLevel;
  shellPolicy?: SkillShellPolicy;
  hookPolicy?: SkillHookPolicy;
  sourceId?: string;
}

/**
 * Skill 注册表配置
 */
export interface SkillRegistryConfig {
  /** 用户级 skills 目录（如 path.join(storageRoot, 'skills')） */
  userSkillsDir?: string;

  /** 项目级 skills 目录（相对于 cwd 或绝对路径） */
  projectSkillsDir?: string;

  /** 当前工作目录 */
  cwd?: string;

  /** 额外的 source（bundled/plugin/mcp 等） */
  additionalSources?: SkillSourceConfig[];
}

/**
 * Skill 发现结果
 */
export interface SkillDiscoveryResult {
  skills: SkillMetadata[];
  errors: Array<{
    path: string;
    error: string;
  }>;
}

export function defaultSkillSource(
  kind: SkillSourceKind,
  rootDir?: string,
  overrides: Partial<Omit<SkillSource, 'kind'>> = {},
): SkillSource {
  const defaults: Record<SkillSourceKind, Omit<SkillSource, 'kind'>> = {
    managed: {
      trustLevel: 'trusted',
      sourceId: 'managed',
      rootDir,
      precedence: 500,
      shellPolicy: 'allow',
      hookPolicy: 'allow',
    },
    user: {
      trustLevel: 'trusted',
      sourceId: 'user',
      rootDir,
      precedence: 200,
      shellPolicy: 'allow',
      hookPolicy: 'allow',
    },
    project: {
      trustLevel: 'workspace',
      sourceId: 'project',
      rootDir,
      precedence: 300,
      shellPolicy: 'inherit',
      hookPolicy: 'inherit',
    },
    bundled: {
      trustLevel: 'trusted',
      sourceId: 'bundled',
      rootDir,
      precedence: 100,
      shellPolicy: 'allow',
      hookPolicy: 'allow',
    },
    plugin: {
      trustLevel: 'workspace',
      sourceId: 'plugin',
      rootDir,
      precedence: 150,
      shellPolicy: 'inherit',
      hookPolicy: 'inherit',
    },
    mcp: {
      trustLevel: 'remote',
      sourceId: 'mcp',
      rootDir,
      precedence: 50,
      shellPolicy: 'deny',
      hookPolicy: 'deny',
    },
  };

  return {
    kind,
    ...defaults[kind],
    ...overrides,
    rootDir: overrides.rootDir ?? rootDir ?? defaults[kind].rootDir,
    sourceId: overrides.sourceId ?? defaults[kind].sourceId,
  };
}
