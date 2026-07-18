// Migrated to @blade-ai/agent-sdk/local
// Wrapper handles structural type mismatch between root and package FunctionDeclaration
import { injectSkillsMetadata as _inject } from '@blade-ai/agent-sdk/local';
import type { FunctionDeclaration } from '../tools/types/index.js';
import type { SkillActivationContext } from './types.js';

export function injectSkillsMetadata(
  tools: FunctionDeclaration[],
  activationContext?: SkillActivationContext,
): FunctionDeclaration[] {
  return _inject(tools as any, activationContext as any) as any;
}
