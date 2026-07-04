import type { HookEvent } from '../types/constants.js';
import type { JsonObject } from '../types/common.js';

export type RuntimePatchScope = 'turn' | 'session';

export interface RuntimeContext {
  id?: string;
  capabilities?: {
    filesystem?: {
      roots: string[];
      cwd?: string;
    };
    browser?: {
      pageId?: string;
      tabId?: string;
    };
    network?: {
      allowDomains?: string[];
    };
  };
  environment?: Record<string, string>;
  metadata?: JsonObject;
}

export interface ContextSnapshot {
  readonly sessionId: string;
  readonly turnId: string;
  readonly context: RuntimeContext;
  readonly filesystemRoots: string[];
  readonly cwd: string | undefined;
  readonly environment: Record<string, string>;
}

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

export type RuntimeHookEvent =
  | typeof HookEvent.PreToolUse
  | typeof HookEvent.PostToolUse
  | typeof HookEvent.PostToolUseFailure
  | typeof HookEvent.PermissionRequest
  | typeof HookEvent.UserPromptSubmit
  | typeof HookEvent.SessionStart
  | typeof HookEvent.SessionEnd
  | typeof HookEvent.TaskCompleted;

export interface RuntimeHookRegistration {
  event: RuntimeHookEvent;
  type: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

export interface RuntimeToolDiscoveryPatch {
  discover?: string[];
  reset?: boolean;
}

export interface RuntimePatch {
  scope: RuntimePatchScope;
  source: 'skill' | 'tool' | 'system';
  skill?: RuntimePatchSkillInfo;
  toolPolicy?: RuntimeToolPolicyPatch;
  toolDiscovery?: RuntimeToolDiscoveryPatch;
  modelOverride?: RuntimeModelOverride;
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  hooks?: RuntimeHookRegistration[];
}

export interface RuntimeContextPatch {
  scope: RuntimePatchScope;
  context?: RuntimeContext;
  reset?: boolean;
}
