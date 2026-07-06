import {
  createPackageLocalRuntimeHookOperations,
  type PackageLocalRuntimeHookManagerPort,
  type PackageLocalRuntimeHookOperations,
} from './runtimeHooks.js';
import {
  createPackageLocalRuntimePermissionOperations,
  type PackageLocalRuntimePermissionHookPort,
  type PackageLocalRuntimePermissionOperations,
} from './runtimePermissions.js';
import type { HookCallback, SessionHookEvent, SessionOptions } from './types.js';

export interface PackageLocalRuntimeGuardOperationsOptions {
  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
  hookManager: PackageLocalRuntimeHookManagerPort;
  permissionHooks: PackageLocalRuntimePermissionHookPort;
  permissionHandler?: SessionOptions['permissionHandler'];
  canUseTool?: SessionOptions['canUseTool'];
}

export interface PackageLocalRuntimeGuardOperations {
  hooks: PackageLocalRuntimeHookOperations;
  permissions: PackageLocalRuntimePermissionOperations;
}

export function createPackageLocalRuntimeGuardOperations(
  options: PackageLocalRuntimeGuardOperationsOptions,
): PackageLocalRuntimeGuardOperations {
  return {
    hooks: createPackageLocalRuntimeHookOperations({
      hookManager: options.hookManager,
      hooks: options.hooks,
    }),
    permissions: createPackageLocalRuntimePermissionOperations({
      hooks: options.hooks,
      permissionHooks: options.permissionHooks,
      permissionHandler: options.permissionHandler,
      canUseTool: options.canUseTool,
    }),
  };
}
