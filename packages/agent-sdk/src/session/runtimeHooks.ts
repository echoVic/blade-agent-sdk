import type { HookCallback, SessionHookEvent } from './types.js';

export interface PackageLocalRuntimeHookManagerPort {
  enable(): void;
}

export interface PackageLocalRuntimeHookRuntimePort extends PackageLocalRuntimeHookManagerPort {
  setTraceCollector?(collector: unknown): void;
}

export interface PackageLocalRuntimeHooksInitializationOptions {
  hookManager: PackageLocalRuntimeHookManagerPort;
  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
}

export function initializePackageLocalRuntimeHooks(
  options: PackageLocalRuntimeHooksInitializationOptions,
): void {
  if (options.hooks && Object.keys(options.hooks).length > 0) {
    options.hookManager.enable();
  }
}
