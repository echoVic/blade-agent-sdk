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

export interface PackageLocalRuntimeTraceCollectorStreamOptions<TChunk> {
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  traceCollector: unknown;
  stream: AsyncIterable<TChunk>;
}

export function initializePackageLocalRuntimeHooks(
  options: PackageLocalRuntimeHooksInitializationOptions,
): void {
  if (options.hooks && Object.keys(options.hooks).length > 0) {
    options.hookManager.enable();
  }
}

export async function* streamWithPackageLocalRuntimeTraceCollector<TChunk>(
  options: PackageLocalRuntimeTraceCollectorStreamOptions<TChunk>,
): AsyncGenerator<TChunk> {
  options.hookRuntime.setTraceCollector?.(options.traceCollector);
  try {
    yield* options.stream;
  } finally {
    options.hookRuntime.setTraceCollector?.(undefined);
  }
}
