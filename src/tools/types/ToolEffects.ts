import type { RuntimeContextPatch, RuntimePatch } from '../../runtime/index.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { PermissionUpdate } from '../../types/permissions.js';

export type ToolEffect =
  | {
      type: 'runtimePatch';
      patch: RuntimePatch;
    }
  | {
      type: 'contextPatch';
      patch: RuntimeContextPatch;
    }
  | {
      type: 'newMessages';
      messages: Message[];
    }
  | {
      type: 'permissionUpdates';
      updates: PermissionUpdate[];
    };

interface NormalizeToolEffectsInput {
  effects?: ToolEffect[];
  runtimePatch?: RuntimePatch;
  contextPatch?: RuntimeContextPatch;
  newMessages?: Message[];
}

interface NormalizePermissionEffectsInput {
  effects?: ToolEffect[];
  updatedPermissions?: PermissionUpdate[];
}

export function getRuntimePatchEffect(effects?: ToolEffect[]): RuntimePatch | undefined {
  return effects?.find(
    (effect): effect is Extract<ToolEffect, { type: 'runtimePatch' }> =>
      effect.type === 'runtimePatch',
  )?.patch;
}

export function normalizeToolEffects(input: NormalizeToolEffectsInput): ToolEffect[] {
  const effects = [...(input.effects ?? [])];

  if (!getRuntimePatchEffect(effects) && input.runtimePatch) {
    effects.push({
      type: 'runtimePatch',
      patch: input.runtimePatch,
    });
  }

  if (!effects.some((effect) => effect.type === 'contextPatch') && input.contextPatch) {
    effects.push({
      type: 'contextPatch',
      patch: input.contextPatch,
    });
  }

  if (
    !effects.some((effect) => effect.type === 'newMessages') &&
    input.newMessages &&
    input.newMessages.length > 0
  ) {
    effects.push({
      type: 'newMessages',
      messages: input.newMessages,
    });
  }

  return effects;
}

export function normalizePermissionEffects(input: NormalizePermissionEffectsInput): ToolEffect[] {
  const effects = [...(input.effects ?? [])];

  if (input.updatedPermissions && input.updatedPermissions.length > 0) {
    effects.push({
      type: 'permissionUpdates',
      updates: input.updatedPermissions,
    });
  }

  return effects;
}
