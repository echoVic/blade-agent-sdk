import type { RuntimeContext } from '../runtime/types.js';

export interface PackageLocalRuntimeBackgroundAgentManagerPort {
  [operation: string]: unknown;
}

export interface PackageLocalAgentRuntimeDeps {
  executionPipeline: unknown;
  defaultContext: RuntimeContext;
  mcpRegistry: unknown;
  subagentRegistry: unknown;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  hookRuntime: unknown;
  runtimeManaged: true;
  logger: unknown;
}

export interface PackageLocalAgentRuntimeDepsOptions {
  executionPipeline: unknown;
  defaultContext: RuntimeContext;
  mcpRegistry: unknown;
  subagentRegistry: unknown;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  hookRuntime: unknown;
  logger: unknown;
}

export interface PackageLocalAgentRuntimeDepsOperations {
  get(): PackageLocalAgentRuntimeDeps;
}

export interface PackageLocalAgentRuntimeDepsOperationsOptions
  extends Omit<PackageLocalAgentRuntimeDepsOptions, 'executionPipeline'> {
  createExecutionPipeline(): unknown;
}

export function createPackageLocalAgentRuntimeDepsOperations(
  options: PackageLocalAgentRuntimeDepsOperationsOptions,
): PackageLocalAgentRuntimeDepsOperations {
  return {
    get() {
      return createPackageLocalAgentRuntimeDeps({
        executionPipeline: options.createExecutionPipeline(),
        defaultContext: options.defaultContext,
        mcpRegistry: options.mcpRegistry,
        subagentRegistry: options.subagentRegistry,
        backgroundAgentManager: options.backgroundAgentManager,
        hookRuntime: options.hookRuntime,
        logger: options.logger,
      });
    },
  };
}

export function createPackageLocalAgentRuntimeDeps(
  options: PackageLocalAgentRuntimeDepsOptions,
): PackageLocalAgentRuntimeDeps {
  return {
    executionPipeline: options.executionPipeline,
    defaultContext: options.defaultContext,
    mcpRegistry: options.mcpRegistry,
    subagentRegistry: options.subagentRegistry,
    backgroundAgentManager: options.backgroundAgentManager,
    hookRuntime: options.hookRuntime,
    runtimeManaged: true,
    logger: options.logger,
  };
}
