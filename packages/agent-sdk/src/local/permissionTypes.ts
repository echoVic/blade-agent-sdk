import type { Message } from '@blade-ai/ai/chat';
import type { JsonObject } from '@blade-ai/ai';
import type { RuntimePatch } from './RuntimePatch.js';
import type { RuntimeContextPatch } from './RuntimeContextPatch.js';

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type PermissionUpdate =
  | {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: 'allow' | 'deny';
    }
  | {
      type: 'removeRules';
      rules: PermissionRuleValue[];
    };

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

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: JsonObject;
      effects?: ToolEffect[];
      updatedPermissions?: PermissionUpdate[];
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    }
  | {
      behavior: 'ask';
      message?: string;
    };
