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

export interface RuntimeToolDiscoveryPatch {
  discover?: string[];
  reset?: boolean;
}

export interface RuntimePatchProvenance {
  toolName?: string;
  toolCallId?: string;
  toolUseUuid?: string | null;
  appliedAt: number;
}

export interface RuntimePatchApplication {
  patch: RuntimePatch;
  provenance: RuntimePatchProvenance;
}

export interface RuntimePatchSummary {
  promptAppends: string[];
  mergedPromptAppend?: string;
  mergedEnvironment?: Record<string, string>;
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

function normalizeRuntimePatchPromptAppend(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRuntimePatchEnvironment(
  environment?: Record<string, string>,
): Record<string, string> | undefined {
  if (!environment) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(environment)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value.trim()]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function summarizeRuntimePatchApplications(
  applications: RuntimePatchApplication[],
): RuntimePatchSummary {
  const promptAppends: string[] = [];
  let mergedEnvironment: Record<string, string> | undefined;

  for (const application of applications) {
    const promptAppend = normalizeRuntimePatchPromptAppend(application.patch.systemPromptAppend);
    if (promptAppend) {
      promptAppends.push(promptAppend);
    }

    const environment = normalizeRuntimePatchEnvironment(application.patch.environment);
    if (environment) {
      mergedEnvironment = {
        ...(mergedEnvironment ?? {}),
        ...environment,
      };
    }
  }

  return {
    promptAppends,
    mergedPromptAppend: promptAppends.length > 0
      ? promptAppends.join('\n\n---\n\n')
      : undefined,
    mergedEnvironment,
  };
}
