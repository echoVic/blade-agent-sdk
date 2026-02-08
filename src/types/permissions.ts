import type { ToolKind } from '../tools/types/ToolTypes.js';

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
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    }
  | {
      behavior: 'ask';
    };

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolKind: ToolKind;
  affectedPaths: string[];
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions
) => Promise<PermissionResult>;
