import { HookEvent } from '../types/constants.js';

export type RuntimePatchScope = 'turn' | 'session';

export interface RuntimePatchSkillInfo {
  id: string;
  name: string;
  basePath: string;
}

export interface RuntimeToolPolicyPatch {
  allow?: string[];
  deny?: string[];
}

export interface RuntimeModelOverride {
  modelId: string;
  effort?: string | number;
}

// RuntimeHookEvent is intentionally a strict subset of HookEvent. When adding
// a new HookEvent that should be activatable through skills/runtime patches,
// update this union and the runtime guard in src/tools/builtin/system/skill.ts
// together so parsed hooks are not silently dropped at activation time.
export type RuntimeHookEvent =
  | HookEvent.PreToolUse
  | HookEvent.PostToolUse
  | HookEvent.PostToolUseFailure
  | HookEvent.PermissionRequest
  | HookEvent.UserPromptSubmit
  | HookEvent.SessionStart
  | HookEvent.SessionEnd
  | HookEvent.TaskCompleted;

export interface RuntimeHookRegistration {
  event: RuntimeHookEvent;
  type: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

export interface RuntimePatch {
  scope: RuntimePatchScope;
  source: 'skill' | 'tool' | 'system';
  skill?: RuntimePatchSkillInfo;
  toolPolicy?: RuntimeToolPolicyPatch;
  modelOverride?: RuntimeModelOverride;
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  hooks?: RuntimeHookRegistration[];
}
