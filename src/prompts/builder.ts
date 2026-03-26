/**
 * 系统提示构建器 - 统一入口
 *
 * ## 构建顺序（固定）
 * 1. 调用方提供的 base prompt（basePrompt）
 * 2. 追加内容（append）
 * 3. 模式特定提示（Plan 模式等）
 *
 * ## 规则
 * - 不内置任何默认 prompt，调用方负责提供 basePrompt
 * - Plan 模式使用独立的 system prompt（PLAN_MODE_SYSTEM_PROMPT），可通过 planModePrompt 覆盖
 * - 项目配置文件（如 BLADE.md）由调用方自行加载后通过 append 注入
 * - 各部分用 `\n\n---\n\n` 分隔
 */

import { getSkillRegistry } from '../skills/index.js';
import { PermissionMode } from '../types/common.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { PLAN_MODE_SYSTEM_PROMPT } from './default.js';

/** available_skills 占位符的正则表达式 */
const AVAILABLE_SKILLS_REGEX = /<available_skills>\s*<\/available_skills>/;

/**
 * 提示词构建选项
 */
export interface BuildSystemPromptOptions {
  /**
   * 项目路径，用于生成环境上下文（git 分支、工作目录等）
   */
  projectPath?: string;

  /**
   * 调用方提供的 base prompt。
   * 不提供时不注入任何默认内容（Plan 模式除外）。
   */
  basePrompt?: string;

  /**
   * 追加到提示词末尾（可用于注入项目配置文件内容，如 CLAUDE.md / BLADE.md）
   */
  append?: string;

  /**
   * 权限模式（Plan 模式会使用独立的 system prompt）
   */
  mode?: PermissionMode;

  /**
   * 是否包含环境上下文（默认 true）
   */
  includeEnvironment?: boolean;

  /**
   * AI 回复语言（如 'zh-CN', 'en-US'）
   */
  language?: string;

  /**
   * 覆盖 Plan 模式的 system prompt（不提供时使用 SDK 内置的 PLAN_MODE_SYSTEM_PROMPT）
   */
  planModePrompt?: string;
}

/**
 * 提示词构建结果
 */
export interface BuildSystemPromptResult {
  /**
   * 最终的系统提示词
   */
  prompt: string;

  /**
   * 各部分来源（用于调试）
   */
  sources: Array<{
    name: string;
    loaded: boolean;
    length?: number;
  }>;
}

/**
 * 构建系统提示词（统一入口）
 *
 * 构建顺序：环境上下文 → basePrompt（或 planModePrompt）→ append
 *
 * @example
 * // 普通模式，调用方提供 base prompt
 * const { prompt } = await buildSystemPrompt({
 *   basePrompt: 'You are a helpful assistant.',
 *   projectPath: '/my/project',
 * });
 *
 * // Plan 模式
 * const { prompt } = await buildSystemPrompt({ mode: PermissionMode.PLAN });
 *
 * // 注入项目配置文件内容
 * const config = await fs.readFile('CLAUDE.md', 'utf-8');
 * const { prompt } = await buildSystemPrompt({
 *   basePrompt: 'You are a helpful assistant.',
 *   append: config,
 * });
 */
export async function buildSystemPrompt(
  options: BuildSystemPromptOptions = {}
): Promise<BuildSystemPromptResult> {
  const {
    projectPath,
    basePrompt,
    append,
    mode,
    includeEnvironment = true,
    language,
    planModePrompt,
  } = options;

  const parts: string[] = [];
  const sources: BuildSystemPromptResult['sources'] = [];

  // 1. 环境上下文（始终在最前面）
  if (includeEnvironment) {
    const envContext = getEnvironmentContext(projectPath);
    if (envContext) {
      parts.push(envContext);
      sources.push({ name: 'environment', loaded: true, length: envContext.length });
    }
  }

  // 2. base prompt（Plan 模式使用独立的 system prompt）
  const isPlanMode = mode === PermissionMode.PLAN;

  if (isPlanMode) {
    const planPrompt = planModePrompt ?? PLAN_MODE_SYSTEM_PROMPT;
    parts.push(planPrompt);
    sources.push({ name: 'plan_mode_prompt', loaded: true, length: planPrompt.length });
  } else if (basePrompt) {
    parts.push(basePrompt);
    sources.push({ name: 'base_prompt', loaded: true, length: basePrompt.length });
  }

  // 3. 追加内容（项目配置文件等由调用方自行加载后传入）
  if (append?.trim()) {
    parts.push(append.trim());
    sources.push({ name: 'append', loaded: true, length: append.trim().length });
  }

  // 组合各部分
  let prompt = parts.join('\n\n---\n\n');

  // 注入 Skills 元数据到 <available_skills> 占位符
  prompt = injectSkillsToPrompt(prompt);

  // 注入语言指令
  prompt = injectLanguageInstruction(prompt, language);

  return { prompt, sources };
}

/**
 * 注入 Skills 列表到系统提示的 <available_skills> 占位符
 */
function injectSkillsToPrompt(prompt: string): string {
  const registry = getSkillRegistry();
  const skillsList = registry.generateAvailableSkillsList();

  // 如果没有 skills，保持占位符为空（但保留标签结构）
  if (!skillsList) {
    return prompt;
  }

  // 替换占位符
  return prompt.replace(
    AVAILABLE_SKILLS_REGEX,
    `<available_skills>\n${skillsList}\n</available_skills>`
  );
}

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Chinese (Simplified Chinese)',
  'zh-TW': 'Chinese (Traditional Chinese)',
  'en-US': 'English',
  'en-GB': 'English (British)',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'pt-BR': 'Portuguese (Brazilian)',
  'ru-RU': 'Russian',
};

function injectLanguageInstruction(prompt: string, language?: string): string {
  const lang = language || 'zh-CN';
  const langName = LANGUAGE_NAMES[lang] || lang;
  
  const instruction = `IMPORTANT: Always respond in ${langName}. All your responses must be in ${langName}.`;
  
  return prompt.replace('{{LANGUAGE_INSTRUCTION}}', instruction);
}

