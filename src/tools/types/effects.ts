import type { ConversationMessage } from '../../model/conversation.js';
import type { RuntimeContextPatch, RuntimePatch } from '../../runtime/index.js';
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
      messages: ConversationMessage[];
    }
  | {
      type: 'permissionUpdates';
      updates: PermissionUpdate[];
    };

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
