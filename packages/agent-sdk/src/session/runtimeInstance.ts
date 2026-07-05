import { basename, dirname } from 'node:path';
import type { RuntimeContext } from '../runtime/types.js';
import type { BladeConfig, McpServerConfig } from '../types/common.js';
import type {
  SdkMcpServerHandle,
  SessionHookEvent,
  SessionId,
  SessionOptions,
  HookCallback,
} from './types.js';

export interface PackageLocalSessionRuntimeOptions {
  sessionId: SessionId;
  options: SessionOptions;
  bladeConfig: BladeConfig;
  defaultContext: RuntimeContext;
}

export function resolvePackageLocalRuntimeStorageRoot(
  storagePath?: string,
): string | undefined {
  if (!storagePath) {
    return undefined;
  }

  return basename(storagePath) === 'sessions' ? dirname(storagePath) : storagePath;
}

export function isPackageLocalSdkMcpServerHandle(
  config: unknown,
): config is SdkMcpServerHandle {
  return (
    typeof config === 'object' &&
    config !== null &&
    'createClientTransport' in config &&
    'server' in config
  );
}

function getRuntimeContextCwd(context: RuntimeContext): string | undefined {
  return typeof context.capabilities?.filesystem?.cwd === 'string'
    ? context.capabilities.filesystem.cwd
    : typeof context.environment?.cwd === 'string'
      ? context.environment.cwd
      : undefined;
}

export class PackageLocalSessionRuntime {
  readonly sessionId: SessionId;
  readonly options: SessionOptions;
  readonly bladeConfig: BladeConfig;
  readonly defaultContext: RuntimeContext;
  readonly storageRoot?: string;
  readonly projectPath?: string;
  readonly hookCallbacks: Partial<Record<SessionHookEvent, HookCallback[]>>;

  constructor(options: PackageLocalSessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.options = options.options;
    this.bladeConfig = options.bladeConfig;
    this.defaultContext = options.defaultContext;
    this.storageRoot =
      options.bladeConfig.storageRoot ??
      resolvePackageLocalRuntimeStorageRoot(options.options.storagePath);
    this.projectPath = getRuntimeContextCwd(options.defaultContext);
    this.hookCallbacks = options.options.hooks ?? {};
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.options.mcpServers ?? {};
  }
}
