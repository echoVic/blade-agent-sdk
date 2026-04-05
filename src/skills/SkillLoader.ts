/**
 * SkillLoader - SKILL.md 文件解析器
 *
 * 负责解析 SKILL.md 文件的 YAML 前置数据和 Markdown 正文内容。
 * 支持 Progressive Disclosure：可以只加载元数据，或加载完整内容。
 * 支持动态上下文插值：正文中的 !`command` 语法在加载时自动执行并替换。
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HookEvent } from '../types/constants.js';
import { getErrorCode } from '../utils/errorUtils.js';
import {
  defaultSkillSource,
  type SkillAssetEntry,
  type SkillAssetManifest,
  type SkillContent,
  type SkillHookSpec,
  type SkillMetadata,
  type SkillParseResult,
  type SkillShellConfig,
  type SkillShellPolicy,
  type SkillSource,
  type SkillSourceKind,
} from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;
const MAX_DESCRIPTION_LENGTH = 1024;
const INLINE_CMD_REGEX = /!`([^`]+)`/g;
const FENCED_CODE_BLOCK_REGEX = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1\s*$/gm;
const INLINE_CMD_TIMEOUT_MS = 10_000;
const INLINE_CMD_MAX_OUTPUT_BYTES = 512 * 1024;
const SHELL_META_CHARS = /[;|&`$(){}]/;

type SourceInput = SkillSourceKind | SkillSource;

interface RawHookSpec {
  event?: string;
  type?: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

interface RawShellConfig {
  enabled?: boolean | string;
  allowlist?: string[] | 'all';
}

interface RawFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string | string[];
  'disallowed-tools'?: string | string[];
  version?: string;
  'argument-hint'?: string;
  'user-invocable'?: boolean | string;
  'disable-model-invocation'?: boolean | string;
  model?: string;
  effort?: number | string;
  scope?: 'turn' | 'session';
  shell?: boolean | string | string[] | RawShellConfig;
  paths?: string | string[];
  hooks?: RawHookSpec[];
  when_to_use?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
}

function parseStringArray(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const hasComma = raw.includes(',');
    const separator = hasComma ? ',' : /\s+/;
    return raw.split(separator).map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function parseAllowedTools(raw: string | string[] | undefined): string[] | undefined {
  return parseStringArray(raw);
}

function parseBoolean(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === 'yes' || lower === '1') return true;
    if (lower === 'false' || lower === 'no' || lower === '0') return false;
  }
  return undefined;
}

function resolveSource(source: SourceInput, _filePath: string): SkillSource {
  if (typeof source !== 'string') {
    return source;
  }
  return defaultSkillSource(source);
}

function parseShellConfig(
  raw: RawFrontmatter['shell'],
  source: SkillSource,
): SkillShellConfig {
  const shellToggle = typeof raw === 'boolean' || typeof raw === 'string'
    ? parseBoolean(raw)
    : undefined;
  if (shellToggle === false) {
    return { enabled: false };
  }

  const policyEnabled = source.shellPolicy !== 'deny';
  if (raw === undefined) {
    return {
      enabled: policyEnabled,
      allowlist: source.shellPolicy === 'allow' ? 'all' : undefined,
    };
  }

  if (raw === true) {
    return {
      enabled: policyEnabled,
      allowlist: source.shellPolicy === 'allow' ? 'all' : undefined,
    };
  }

  if (typeof raw === 'string') {
    return {
      enabled: policyEnabled,
      allowlist: raw === 'all' ? 'all' : [raw],
    };
  }

  if (Array.isArray(raw)) {
    return {
      enabled: policyEnabled,
      allowlist: raw.map((item) => String(item)),
    };
  }

  const objectConfig = raw && typeof raw === 'object' ? raw : {};
  const explicitEnabled = parseBoolean(objectConfig.enabled);
  return {
    enabled: explicitEnabled ?? policyEnabled,
    allowlist: objectConfig.allowlist,
  };
}

function parseHooks(rawHooks: RawHookSpec[] | undefined): SkillHookSpec[] | undefined {
  if (!rawHooks || rawHooks.length === 0) {
    return undefined;
  }

  // Hooks are parsed as part of the compiled skill object so activation-time
  // runtime code can decide whether and how to register them.
  const hooks = rawHooks.flatMap((hook): SkillHookSpec[] => {
    if (!hook?.event || !hook?.type) {
      return [];
    }

    if (!Object.values(HookEvent).includes(hook.event as HookEvent)) {
      return [];
    }

    return [{
      event: hook.event as HookEvent,
      type: hook.type,
      value: hook.value,
      tools: hook.tools,
      once: hook.once,
    }];
  });

  return hooks.length > 0 ? hooks : undefined;
}

function validateMetadata(
  frontmatter: RawFrontmatter,
  filePath: string,
  source: SkillSource,
):
  | { valid: true; metadata: Omit<SkillMetadata, 'path' | 'basePath' | 'source'> }
  | { valid: false; error: string } {
  if (!frontmatter.name) {
    return { valid: false, error: 'Missing required field: name' };
  }
  if (!NAME_REGEX.test(frontmatter.name)) {
    return {
      valid: false,
      error: `Invalid name "${frontmatter.name}": must be lowercase letters, numbers, and hyphens only, 1-64 characters`,
    };
  }

  if (!frontmatter.description) {
    return { valid: false, error: 'Missing required field: description' };
  }
  if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description too long: ${frontmatter.description.length} characters (max ${MAX_DESCRIPTION_LENGTH})`,
    };
  }

  const model = frontmatter.model
    ? frontmatter.model === 'inherit'
      ? 'inherit'
      : frontmatter.model
    : undefined;
  const allowedTools = parseAllowedTools(frontmatter['allowed-tools']);
  const deniedTools = parseAllowedTools(frontmatter['disallowed-tools']);
  const shell = parseShellConfig(frontmatter.shell, source);

  return {
    valid: true,
    metadata: {
      name: frontmatter.name,
      description: frontmatter.description.trim(),
      allowedTools,
      disallowedTools: deniedTools,
      version: frontmatter.version,
      argumentHint: frontmatter['argument-hint']?.trim(),
      userInvocable: parseBoolean(frontmatter['user-invocable']),
      disableModelInvocation: parseBoolean(frontmatter['disable-model-invocation']),
      model,
      whenToUse: frontmatter.when_to_use?.trim(),
      runtimeEffects: {
        allowedTools,
        deniedTools,
        modelId: model && model !== 'inherit' ? model : undefined,
        effort: frontmatter.effort,
        activeScope: frontmatter.scope ?? 'session',
      },
      conditions: frontmatter.paths
        ? { paths: parseStringArray(frontmatter.paths) }
        : undefined,
      shell,
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata,
    },
  };
}

function parseSkillContent(
  content: string,
  filePath: string,
  sourceInput: SourceInput,
): SkillParseResult {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      success: false,
      error: 'Invalid SKILL.md format: missing YAML frontmatter (must start with ---)',
    };
  }

  const source = resolveSource(sourceInput, filePath);
  const [, yamlContent, markdownContent] = match;

  let frontmatter: RawFrontmatter;
  try {
    frontmatter = parseYaml(yamlContent) as RawFrontmatter;
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const validation = validateMetadata(frontmatter, filePath, source);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
    };
  }

  const basePath = path.dirname(filePath);

  return {
    success: true,
    content: {
      metadata: {
        ...validation.metadata,
        path: filePath,
        basePath,
        source,
      },
      instructions: markdownContent.trim(),
      hooks: parseHooks(frontmatter.hooks),
      assets: {
        scripts: [],
        references: [],
        templates: [],
      },
    },
  };
}

export async function processInlineCommands(
  content: string,
  cwd: string,
  options?: {
    allowlist?: string[] | 'all';
    logger?: { info(msg: string): void; warn(msg: string): void };
    skillName?: string;
  },
): Promise<string> {
  const { allowlist = 'all', logger, skillName } = options ?? {};

  if (!content.includes('!`')) return content;

  const fencedRanges: Array<[number, number]> = [];
  {
    const fencedRegex = new RegExp(FENCED_CODE_BLOCK_REGEX.source, 'gm');
    let m: RegExpExecArray | null = fencedRegex.exec(content);
    while (m !== null) {
      fencedRanges.push([m.index, m.index + m[0].length]);
      m = fencedRegex.exec(content);
    }
  }

  const isInFencedBlock = (index: number): boolean =>
    fencedRanges.some(([start, end]) => index >= start && index < end);

  type CmdEntry = { cmd: string; index: number; fullMatch: string };
  const entries: CmdEntry[] = [];
  {
    const regex = new RegExp(INLINE_CMD_REGEX.source, 'g');
    let m: RegExpExecArray | null = regex.exec(content);
    while (m !== null) {
      if (!isInFencedBlock(m.index)) {
        entries.push({ cmd: m[1], index: m.index, fullMatch: m[0] });
      }
      m = regex.exec(content);
    }
  }

  if (entries.length === 0) return content;

  const results = await Promise.all(
    entries.map(async ({ cmd }) => {
      const logCtx = skillName ? ` (skill: ${skillName}, cwd: ${cwd})` : ` (cwd: ${cwd})`;
      logger?.info(`[SkillLoader] 执行内联命令: \`${cmd}\`${logCtx}`);

      if (allowlist !== 'all' && Array.isArray(allowlist)) {
        const prefixMatch = allowlist.some((prefix) => cmd === prefix.trimEnd() || cmd.startsWith(prefix));
        if (!prefixMatch || SHELL_META_CHARS.test(cmd)) {
          const reason = !prefixMatch ? 'allowlist 前缀不匹配' : '包含 shell 元字符';
          logger?.warn(`[SkillLoader] 内联命令被 allowlist 拦截 (${reason}): \`${cmd}\``);
          return '(unavailable)';
        }
      }

      return executeShellCommand(cmd, cwd, logger);
    }),
  );

  let result = content;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { fullMatch, index } = entries[i];
    const replacement = results[i];
    result = result.slice(0, index) + replacement + result.slice(index + fullMatch.length);
  }

  return result;
}

async function executeShellCommand(
  cmd: string,
  cwd: string,
  logger?: { info(msg: string): void; warn(msg: string): void },
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    let stdoutBytes = 0;
    let truncated = false;

    const child = spawn('sh', ['-c', cmd], {
      cwd,
      env: { ...process.env },
      timeout: INLINE_CMD_TIMEOUT_MS,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > INLINE_CMD_MAX_OUTPUT_BYTES) {
        truncated = true;
        logger?.warn(`[SkillLoader] 内联命令输出超过 ${INLINE_CMD_MAX_OUTPUT_BYTES / 1024}KB，已截断: \`${cmd}\``);
        return;
      }
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', () => {});

    child.on('error', (err) => {
      logger?.warn(`[SkillLoader] 内联命令执行失败: \`${cmd}\` — ${err.message}`);
      resolve('(unavailable)');
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        logger?.warn(`[SkillLoader] 内联命令超时: \`${cmd}\``);
        resolve('(unavailable)');
        return;
      }
      if (code !== 0) {
        logger?.warn(`[SkillLoader] 内联命令非零退出 (exit ${code}): \`${cmd}\``);
        resolve('(unavailable)');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function renderSkillTemplate(instructions: string, args?: string): string {
  if (!args) {
    return instructions;
  }
  return instructions
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .replace(/\{\{\s*args\.raw\s*\}\}/g, args);
}

function mergeInlineAllowlist(
  metadata: SkillMetadata,
  options?: Parameters<typeof processInlineCommands>[2],
): string[] | 'all' | undefined {
  if (metadata.shell?.allowlist) {
    return metadata.shell.allowlist;
  }
  if (metadata.source.shellPolicy === 'allow') {
    return options?.allowlist ?? 'all';
  }
  return options?.allowlist;
}

function canProcessInlineCommands(metadata: SkillMetadata): boolean {
  return metadata.shell?.enabled !== false && metadata.source.shellPolicy !== 'deny';
}

async function discoverSkillAssetDir(
  basePath: string,
  dirName: 'scripts' | 'references' | 'templates',
): Promise<SkillAssetEntry[]> {
  const targetDir = path.join(basePath, dirName);
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        path: `${dirName}/${entry.name}`,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

export async function discoverSkillAssets(basePath: string): Promise<SkillAssetManifest> {
  const [scripts, references, templates] = await Promise.all([
    discoverSkillAssetDir(basePath, 'scripts'),
    discoverSkillAssetDir(basePath, 'references'),
    discoverSkillAssetDir(basePath, 'templates'),
  ]);

  return {
    scripts,
    references,
    templates,
  };
}

export async function loadSkillMetadata(
  filePath: string,
  source: SourceInput,
): Promise<SkillParseResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseSkillContent(content, filePath, source);
  } catch (e) {
    if (getErrorCode(e) === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${filePath}`,
      };
    }
    return {
      success: false,
      error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function loadSkillContent(
  metadata: SkillMetadata,
  options?: {
    cwd?: string;
    args?: string;
    inlineCommandOptions?: Parameters<typeof processInlineCommands>[2];
  },
): Promise<SkillContent | null> {
  try {
    const content = await fs.readFile(metadata.path, 'utf-8');
    const result = parseSkillContent(content, metadata.path, metadata.source);
    if (!result.success || !result.content) return null;

    if (
      options?.cwd &&
      result.content.instructions.includes('!`') &&
      canProcessInlineCommands(result.content.metadata)
    ) {
      result.content.instructions = await processInlineCommands(
        result.content.instructions,
        options.cwd,
        {
          ...options.inlineCommandOptions,
          allowlist: mergeInlineAllowlist(result.content.metadata, options.inlineCommandOptions),
        },
      );
    }

    result.content.instructions = renderSkillTemplate(result.content.instructions, options?.args);

    result.content.assets = await discoverSkillAssets(metadata.basePath);
    result.content.scripts = result.content.assets.scripts.map((asset) => asset.path);

    return result.content;
  } catch {
    return null;
  }
}

export async function discoverSkillScripts(basePath: string): Promise<string[]> {
  const assets = await discoverSkillAssets(basePath);
  return assets.scripts.map((asset) => asset.path);
}

export async function hasSkillFile(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}
