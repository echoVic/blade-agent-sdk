import type { ObservabilityOptions } from '../observability/types.js';
import type { AgentTrace } from '../observability/types.js';
import {
  PermissionMode,
  type ProviderType,
} from '../types/common.js';
import type { SessionId } from './types.js';
import { SessionTraceManager } from './traces.js';

export interface PackageLocalRuntimeTraceLoggerPort {
  warn(...args: unknown[]): void;
}

export interface PackageLocalRuntimeTraceManagerOptions {
  sessionId: SessionId;
  observability?: ObservabilityOptions;
  model?: string;
  providerType: ProviderType;
  permissionMode?: PermissionMode;
  logger: PackageLocalRuntimeTraceLoggerPort;
}

export interface PackageLocalRuntimeTraceAccessPort {
  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
}

export interface PackageLocalRuntimeTraceOperations {
  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
}

export interface PackageLocalRuntimeTraceOperationsOptions {
  traceManager: PackageLocalRuntimeTraceAccessPort;
}

export interface PackageLocalRuntimeTraceRuntime {
  traceManager: SessionTraceManager;
  traceOperations: PackageLocalRuntimeTraceOperations;
}

export function createPackageLocalRuntimeTraceOperations(
  options: PackageLocalRuntimeTraceOperationsOptions,
): PackageLocalRuntimeTraceOperations {
  return {
    getLastTrace() {
      return options.traceManager.getLastTrace();
    },
    getTraces() {
      return options.traceManager.getTraces();
    },
  };
}

export function createPackageLocalRuntimeTraceManager(
  options: PackageLocalRuntimeTraceManagerOptions,
): SessionTraceManager {
  return new SessionTraceManager({
    sessionId: options.sessionId,
    observability: options.observability,
    metadata: {
      model: options.model,
      provider: options.providerType,
      permissionMode: options.permissionMode ?? PermissionMode.DEFAULT,
    },
    onSinkError: (error) =>
      options.logger.warn(
        '[PackageLocalSessionRuntime] Observability trace sink failed:',
        error,
      ),
  });
}

export function createPackageLocalRuntimeTraceRuntime(
  options: PackageLocalRuntimeTraceManagerOptions,
): PackageLocalRuntimeTraceRuntime {
  const traceManager = createPackageLocalRuntimeTraceManager(options);
  return {
    traceManager,
    traceOperations: createPackageLocalRuntimeTraceOperations({
      traceManager,
    }),
  };
}
