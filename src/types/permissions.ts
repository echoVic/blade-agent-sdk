import type { ToolEffect } from '../tools/types/ToolEffects.js';
import type { ToolKind } from '../tools/types/ToolKind.js';
import { ToolKind as ToolKindValue } from '../tools/types/ToolKind.js';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../tools/validation/SensitiveFileDetector.js';
import type { JsonObject } from './common.js';
import { PermissionMode, type PermissionsConfig } from './common.js';

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

interface PathSafetyPermissionOptions {
  explicitAllowRules?: string[];
}

type CompositePermissionStrategy = 'first-wins' | 'deny-wins';

export function createPermissionHandlerFromCanUseTool(
  canUseTool: CanUseTool
): PermissionHandler {
  return async (request) =>
    canUseTool(request.toolName, request.input, {
      signal: request.signal,
      toolKind: request.toolKind,
      affectedPaths: request.affectedPaths,
    });
}

export function createModePermissionHandler(
  defaultMode: PermissionMode = PermissionMode.DEFAULT
): PermissionHandler {
  return async (request) => {
    const permissionMode = request.permissionMode ?? defaultMode;

    if (request.sessionApproved) {
      return {
        behavior: 'allow',
      };
    }

    if (permissionMode === PermissionMode.YOLO) {
      return {
        behavior: 'allow',
      };
    }

    if (permissionMode === PermissionMode.PLAN && !request.toolMeta.isReadOnly) {
      return {
        behavior: 'deny',
        message:
          'Plan mode: modification tools are blocked; only read-only tools are allowed (Read/Glob/Grep/WebFetch/WebSearch/Task)',
      };
    }

    if (request.toolMeta.isReadOnly) {
      return {
        behavior: 'allow',
      };
    }

    if (permissionMode === PermissionMode.AUTO_EDIT && request.toolKind === ToolKindValue.Write) {
      return {
        behavior: 'allow',
      };
    }

    return {
      behavior: 'ask',
      message: 'User confirmation required',
    };
  };
}

export function createRuleBasedPermissionHandler(
  config: PermissionsConfig = {}
): PermissionHandler {
  const allow = config.allow ?? [];
  const ask = config.ask ?? [];
  const deny = config.deny ?? [];

  return async (request) => {
    const signature = request.toolMeta.signature?.trim() || request.toolName;

    if (deny.some((rule) => matchPermissionRule(signature, rule))) {
      return {
        behavior: 'deny',
        message: 'Denied by permission rule',
      };
    }

    if (allow.some((rule) => matchPermissionRule(signature, rule))) {
      return {
        behavior: 'allow',
      };
    }

    if (ask.some((rule) => matchPermissionRule(signature, rule))) {
      return {
        behavior: 'ask',
        message: 'Requires user confirmation',
      };
    }

    return {
      behavior: 'ask',
      message: 'Default: requires user confirmation',
    };
  };
}

export function createPathSafetyPermissionHandler(
  options: PathSafetyPermissionOptions = {}
): PermissionHandler {
  return async (request) => {
    if (request.affectedPaths.length === 0) {
      return { behavior: 'allow' };
    }

    const dangerousSystemPaths = [
      '/etc/',
      '/sys/',
      '/proc/',
      '/dev/',
      '/boot/',
      '/root/',
      'C:\\Windows\\System32',
      'C:\\Program Files',
      'C:\\ProgramData',
    ];

    const dangerousPaths = request.affectedPaths.filter((filePath) => {
      if (filePath.includes('..')) {
        return true;
      }

      return dangerousSystemPaths.some((dangerousPath) => filePath.includes(dangerousPath));
    });

    if (dangerousPaths.length > 0) {
      return {
        behavior: 'deny',
        message: `Access to dangerous system paths denied: ${dangerousPaths.join(', ')}`,
      };
    }

    const sensitiveFiles = SensitiveFileDetector.filterSensitive(
      request.affectedPaths,
      SensitivityLevel.MEDIUM,
    );
    if (sensitiveFiles.length === 0) {
      return { behavior: 'allow' };
    }

    const warnings = sensitiveFiles.map(
      ({ path: filePath, result }) => `${filePath} (${result.level}: ${result.reason})`,
    );
    const hasHighSensitivity = sensitiveFiles.some(
      ({ result }) => result.level === SensitivityLevel.HIGH,
    );
    const signature = request.toolMeta.signature;
    const hasExplicitAllow = Boolean(
      signature
      && (options.explicitAllowRules ?? []).some((rule) =>
        matchPermissionRule(signature, rule),
      ),
    );

    if (hasHighSensitivity && !hasExplicitAllow) {
      return {
        behavior: 'deny',
        message:
          `Access to highly sensitive files denied:\n${warnings.join('\n')}\n\nIf access is required, add an explicit allow rule in permissions.`,
      };
    }

    if (hasExplicitAllow) {
      return {
        behavior: 'ask',
        message:
          `Sensitive file access detected:\n${warnings.join('\n')}\n\nConfirm to proceed?`,
      };
    }

    return { behavior: 'allow' };
  };
}

export function createCompositePermissionHandler(
  handlers: Array<PermissionHandler | undefined>,
  strategy: CompositePermissionStrategy = 'first-wins',
): PermissionHandler {
  const activeHandlers = handlers.filter((handler): handler is PermissionHandler => Boolean(handler));

  return async (request) => {
    let mergedAllowResult: Extract<PermissionResult, { behavior: 'allow' }> = {
      behavior: 'allow',
    };
    let firstAskResult: Extract<PermissionResult, { behavior: 'ask' }> | undefined;

    for (const handler of activeHandlers) {
      const result = await handler(request);

      if (result.behavior === 'deny') {
        return result;
      }

      if (result.behavior === 'ask') {
        if (strategy === 'first-wins') {
          return result;
        }
        firstAskResult ??= result;
        continue;
      }

      if (result.updatedInput) {
        Object.assign(request.input, result.updatedInput);
        mergedAllowResult.updatedInput = {
          ...(mergedAllowResult.updatedInput ?? {}),
          ...result.updatedInput,
        };
      }

      if (result.effects && result.effects.length > 0) {
        mergedAllowResult.effects = [
          ...(mergedAllowResult.effects ?? []),
          ...result.effects,
        ];
      }

      if (result.updatedPermissions && result.updatedPermissions.length > 0) {
        mergedAllowResult.updatedPermissions = [
          ...(mergedAllowResult.updatedPermissions ?? []),
          ...result.updatedPermissions,
        ];
      }
    }

    return firstAskResult ?? mergedAllowResult;
  };
}

function matchPermissionRule(signature: string, rule: string): boolean {
  if (rule === '*') {
    return true;
  }
  if (rule.endsWith('*')) {
    return signature.startsWith(rule.slice(0, -1));
  }
  return signature === rule;
}
