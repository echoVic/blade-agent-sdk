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
import { getErrorCode } from '../utils/errorUtils.js';
import type { SkillContent, SkillMetadata, SkillParseResult } from './types.js';

/** YAML 前置数据的分隔符 */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Skill 名称验证：小写字母、数字、连字符，≤64字符 */
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

/** 描述最大长度 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 内联命令匹配：!`command` */
const INLINE_CMD_REGEX = /!`([^`]+)`/g;

/** fenced 代码块匹配（``` 或 ~~~，含语言标识，允许前导空格/缩进）*/
const FENCED_CODE_BLOCK_REGEX = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1\s*$/gm;

/** 内联命令执行超时（毫秒）*/
const INLINE_CMD_TIMEOUT_MS = 10_000;

/** 内联命令输出最大字节数（防止超大输出污染上下文）*/
const INLINE_CMD_MAX_OUTPUT_BYTES = 512 * 1024;

/** shell 命令链接/注入元字符（用于 allowlist 安全检查）*/
const SHELL_META_CHARS = /[;|&`$(){}]/;

/**
 * 解析 SKILL.md 的 YAML 前置数据
 * 完全对齐 Claude Code Skills 规范和 agentskills.io 规范
 */
interface RawFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string | string[];
  version?: string;
  /** 参数提示，如 '<file_path>' */
  'argument-hint'?: string;
  /** 是否支持 /skill-name 调用 */
  'user-invocable'?: boolean | string;
  /** 是否禁止 AI 自动调用 */
  'disable-model-invocation'?: boolean | string;
  /** 指定模型 */
  model?: string;
  /** 额外触发条件 */
  when_to_use?: string;
  /** 许可证 */
  license?: string;
  /** 环境兼容性说明 */
  compatibility?: string;
  /** 任意元数据键值对 */
  metadata?: Record<string, unknown>;
}

/**
 * 验证并规范化 allowed-tools 字段
 * 同时支持：
 * - 空格分隔（官方规范）：'Bash(git:*) Read Grep'
 * - 逗号分隔（兼容旧格式）：'Read, Grep'
 * - 数组格式
 */
function parseAllowedTools(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    // 若包含逗号，使用逗号分隔（兼容旧格式）；否则使用空格分隔（官方规范）
    const hasComma = raw.includes(',');
    const separator = hasComma ? ',' : /\s+/;
    return raw.split(separator).map((t) => t.trim()).filter(Boolean);
  }

  return undefined;
}

/**
 * 解析布尔值字段（支持 true/false 字符串）
 */
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

/**
 * 验证 Skill 元数据
 */
function validateMetadata(
  frontmatter: RawFrontmatter,
  filePath: string
):
  | { valid: true; metadata: Omit<SkillMetadata, 'path' | 'basePath' | 'source'> }
  | { valid: false; error: string } {
  // 验证 name
  if (!frontmatter.name) {
    return { valid: false, error: 'Missing required field: name' };
  }
  if (!NAME_REGEX.test(frontmatter.name)) {
    return {
      valid: false,
      error: `Invalid name "${frontmatter.name}": must be lowercase letters, numbers, and hyphens only, 1-64 characters`,
    };
  }

  // 验证 description
  if (!frontmatter.description) {
    return { valid: false, error: 'Missing required field: description' };
  }
  if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description too long: ${frontmatter.description.length} characters (max ${MAX_DESCRIPTION_LENGTH})`,
    };
  }

  // 解析 model 字段
  let model: string | undefined;
  if (frontmatter.model) {
    // 'inherit' 表示继承当前模型，其他值为具体模型名
    model = frontmatter.model === 'inherit' ? 'inherit' : frontmatter.model;
  }

  return {
    valid: true,
    metadata: {
      name: frontmatter.name,
      description: frontmatter.description.trim(),
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
      version: frontmatter.version,
      argumentHint: frontmatter['argument-hint']?.trim(),
      userInvocable: parseBoolean(frontmatter['user-invocable']),
      disableModelInvocation: parseBoolean(frontmatter['disable-model-invocation']),
      model,
      whenToUse: frontmatter.when_to_use?.trim(),
      runtimeEffects: {
        allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
        modelId: model && model !== 'inherit' ? model : undefined,
      },
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata,
    },
  };
}

/**
 * 解析 SKILL.md 文件内容（纯函数，不执行任何 IO）
 */
function parseSkillContent(
  content: string,
  filePath: string,
  source: 'user' | 'project' | 'builtin'
): SkillParseResult {
  // 匹配 YAML 前置数据
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      success: false,
      error: 'Invalid SKILL.md format: missing YAML frontmatter (must start with ---)',
    };
  }

  const [, yamlContent, markdownContent] = match;

  // 解析 YAML
  let frontmatter: RawFrontmatter;
  try {
    frontmatter = parseYaml(yamlContent) as RawFrontmatter;
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 验证元数据
  const validation = validateMetadata(frontmatter, filePath);
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
    },
  };
}

/**
 * 处理内容中的内联命令（!`command` 语法）
 *
 * 在技能内容加载时自动执行 !`command` 占位符并替换为命令输出。
 * 此函数可用于 SKILL.md 等任何指令文件的内容处理。
 *
 * 安全机制：
 * - 跳过 fenced 代码块内的 !`command`（避免误执行示例代码）
 * - 支持 allowlist 过滤（仅允许特定前缀的命令）
 * - 固定 10 秒超时，失败时降级为 "(unavailable)"
 * - 强制记录执行日志
 *
 * @param content   原始文本内容
 * @param cwd       命令执行的工作目录（通常为项目根目录）
 * @param options   可选配置
 */
export async function processInlineCommands(
  content: string,
  cwd: string,
  options?: {
    /** 命令允许列表（前缀匹配）。'all' 或 undefined = 允许所有命令 */
    allowlist?: string[] | 'all';
    /** 日志接口（不提供则静默）*/
    logger?: { info(msg: string): void; warn(msg: string): void };
    /** 技能名称，用于日志上下文 */
    skillName?: string;
  }
): Promise<string> {
  const { allowlist = 'all', logger, skillName } = options ?? {};

  // 快速检查：无内联命令则直接返回
  if (!content.includes('!`')) return content;

  // 收集 fenced 代码块的位置范围（这些区域内的 !`cmd` 不执行）
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

  // 收集所有内联命令及其位置
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

  // 并发执行所有命令
  const results = await Promise.all(
    entries.map(async ({ cmd }) => {
      const logCtx = skillName ? ` (skill: ${skillName}, cwd: ${cwd})` : ` (cwd: ${cwd})`;
      logger?.info(`[SkillLoader] 执行内联命令: \`${cmd}\`${logCtx}`);

      // 允许列表检查
      if (allowlist !== 'all' && Array.isArray(allowlist)) {
        const prefixMatch = allowlist.some((prefix) => cmd === prefix.trimEnd() || cmd.startsWith(prefix));
        if (!prefixMatch || SHELL_META_CHARS.test(cmd)) {
          const reason = !prefixMatch ? 'allowlist 前缀不匹配' : '包含 shell 元字符';
          logger?.warn(`[SkillLoader] 内联命令被 allowlist 拦截 (${reason}): \`${cmd}\``);
          return '(unavailable)';
        }
      }

      return executeShellCommand(cmd, cwd, logger);
    })
  );

  // 按原顺序替换（从后往前，避免偏移问题）
  let result = content;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { fullMatch, index } = entries[i];
    const replacement = results[i];
    result = result.slice(0, index) + replacement + result.slice(index + fullMatch.length);
  }

  return result;
}

/**
 * 执行单条 shell 命令（内部工具函数）
 */
async function executeShellCommand(
  cmd: string,
  cwd: string,
  logger?: { info(msg: string): void; warn(msg: string): void }
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

    child.stderr.on('data', () => {
      // 消费 stderr 数据防止管道背压阻塞，但不注入正文（避免噪声污染 prompt）
    });

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

/**
 * 从文件加载 Skill（仅元数据）
 */
export async function loadSkillMetadata(
  filePath: string,
  source: 'user' | 'project' | 'builtin'
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

/**
 * 加载完整 Skill 内容，可选执行内联命令替换
 */
export async function loadSkillContent(
  metadata: SkillMetadata,
  options?: {
    /** 内联命令执行的工作目录（项目根目录）。不提供时跳过内联命令处理 */
    cwd?: string;
    /** 内联命令选项（allowlist、logger 等）*/
    inlineCommandOptions?: Parameters<typeof processInlineCommands>[2];
  }
): Promise<SkillContent | null> {
  try {
    const content = await fs.readFile(metadata.path, 'utf-8');
    const result = parseSkillContent(content, metadata.path, metadata.source);
    if (!result.success || !result.content) return null;

    // 若提供了 cwd 且正文含内联命令，则处理替换
    if (options?.cwd && result.content.instructions.includes('!`')) {
      result.content.instructions = await processInlineCommands(
        result.content.instructions,
        options.cwd,
        options.inlineCommandOptions
      );
    }

    // 扫描 scripts/ 目录
    result.content.scripts = await discoverSkillScripts(metadata.basePath);

    return result.content;
  } catch {
    return null;
  }
}

/**
 * 扫描 Skill 的 scripts/ 目录，返回可用脚本的相对路径列表
 */
export async function discoverSkillScripts(basePath: string): Promise<string[]> {
  const scriptsDir = path.join(basePath, 'scripts');
  try {
    const entries = await fs.readdir(scriptsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => `scripts/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 检查目录中是否存在 SKILL.md
 */
export async function hasSkillFile(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}
