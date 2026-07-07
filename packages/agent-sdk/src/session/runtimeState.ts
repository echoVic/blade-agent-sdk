import type { RuntimeContext } from '../runtime/types.js';
import type { BladeConfig } from '../types/common.js';
import type { HookCallback, SessionHookEvent, SessionOptions } from './types.js';
import {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from './runtimeContext.js';

export interface PackageLocalRuntimeInitialStateOptions {
  options: SessionOptions;
  bladeConfig: BladeConfig;
  defaultContext: RuntimeContext;
}

export interface PackageLocalRuntimeInitialState {
  storageRoot?: string;
  projectPath?: string;
  hookCallbacks: Partial<Record<SessionHookEvent, HookCallback[]>>;
}

export function createPackageLocalRuntimeInitialState(
  options: PackageLocalRuntimeInitialStateOptions,
): PackageLocalRuntimeInitialState {
  return {
    storageRoot:
      options.bladeConfig.storageRoot ??
      resolvePackageLocalRuntimeStorageRoot(options.options.storagePath),
    projectPath: getPackageLocalRuntimeContextCwd(options.defaultContext),
    hookCallbacks: options.options.hooks ?? {},
  };
}
