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

// The canonical ContextSnapshot lives in local/ContextSnapshot.ts (branded
// sessionId + createContextSnapshot/mergeContext implementations); the former
// duplicate here declared a stale plain-string sessionId.
import type { ContextSnapshot } from '../local/ContextSnapshot.js';
export type { ContextSnapshot };

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
