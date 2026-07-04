import type { ToolEffect } from '../../../../src/tools/types/index.js';
import type { ToolKind } from '../../../../src/tools/types/ToolKind.js';
import type { JsonObject, PermissionMode } from './common.js';

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

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolKind: ToolKind;
  affectedPaths: string[];
}

export type CanUseTool = (
  toolName: string,
  input: JsonObject,
  options: CanUseToolOptions
) => Promise<PermissionResult>;

export interface PermissionHandlerRequest {
  toolName: string;
  input: JsonObject;
  signal: AbortSignal;
  permissionMode?: PermissionMode;
  sessionApproved?: boolean;
  affectedPaths: string[];
  toolKind: ToolKind;
  toolMeta: {
    isReadOnly: boolean;
    isConcurrencySafe: boolean;
    isDestructive: boolean;
    signature?: string;
    description?: string;
  };
}

export type PermissionHandler = (
  request: PermissionHandlerRequest
) => Promise<PermissionResult>;
