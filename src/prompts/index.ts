/**
 * Prompts 模块入口
 * 导出系统提示相关的核心功能
 */

export type { BuildSystemPromptOptions, BuildSystemPromptResult } from './builder.js';
export { buildSystemPrompt } from './builder.js';

// Migrated to @blade-ai/agent-sdk/local
export { createPlanModeReminder, PLAN_MODE_SYSTEM_PROMPT } from '@blade-ai/agent-sdk/local';
