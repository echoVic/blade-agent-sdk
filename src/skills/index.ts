/**
 * Skills 系统
 *
 * ⚠️ MIGRATED: All exports now re-export from @blade-ai/agent-sdk/local.
 *
 * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。
 */

export { injectSkillsMetadata } from '@blade-ai/agent-sdk/local';
export { discoverSkills, getSkillRegistry } from '@blade-ai/agent-sdk/local';
export {
  collectSkillActivationPaths,
  filterSkillsByActivation,
  isSkillAvailableInContext,
} from '@blade-ai/agent-sdk/local';
export type { SkillActivationContext } from '@blade-ai/agent-sdk/local';
