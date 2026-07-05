import type { JsonObject } from '../types/common.js';
import {
  createCompositePermissionHandler,
  createPermissionHandlerFromCanUseTool,
  type PermissionHandler,
  type PermissionResult,
} from '../types/permissions.js';
import type { ToolKind } from '../tools/types/ToolKind.js';
import type { SessionOptions } from './types.js';

export interface PackageLocalRuntimePermissionHookResult {
  updatedInput: JsonObject;
  decision?: PermissionResult;
}

export interface PackageLocalRuntimePermissionHookPort {
  applyPermissionRequestHooks(
    toolName: string,
    input: JsonObject,
    options: {
      affectedPaths?: string[];
      toolKind?: ToolKind;
      abortSignal?: AbortSignal;
    },
  ): Promise<PackageLocalRuntimePermissionHookResult>;
}

export interface PackageLocalRuntimePermissionHandlerOptions {
  hasPermissionCallbacks: boolean;
  permissionHooks: PackageLocalRuntimePermissionHookPort;
  permissionHandler?: PermissionHandler;
  canUseTool?: SessionOptions['canUseTool'];
}

export function createPackageLocalRuntimePermissionHandler(
  options: PackageLocalRuntimePermissionHandlerOptions,
): PermissionHandler | undefined {
  const basePermissionHandler =
    options.permissionHandler ??
    (options.canUseTool ? createPermissionHandlerFromCanUseTool(options.canUseTool) : undefined);

  if (!options.hasPermissionCallbacks && !basePermissionHandler) {
    return undefined;
  }

  const hookPermissionHandler = options.hasPermissionCallbacks
    ? (async (request) => {
        const hookResult = await options.permissionHooks.applyPermissionRequestHooks(
          request.toolName,
          request.input,
          {
            affectedPaths: request.affectedPaths,
            toolKind: request.toolKind,
            abortSignal: request.signal,
          },
        );
        Object.assign(request.input, hookResult.updatedInput);
        if (hookResult.decision) {
          return hookResult.decision;
        }

        return {
          behavior: 'allow',
          updatedInput: hookResult.updatedInput,
        } satisfies PermissionResult;
      }) satisfies PermissionHandler
    : undefined;

  return createCompositePermissionHandler([
    hookPermissionHandler,
    basePermissionHandler,
    async () => ({ behavior: 'ask' }) satisfies PermissionResult,
  ]);
}
