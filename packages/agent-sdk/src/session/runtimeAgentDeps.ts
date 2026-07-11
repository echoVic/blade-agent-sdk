import type { RuntimeContext } from '../runtime/types.js';
import type { PackageLocalRuntimeHookRuntimePort } from './runtimeHooks.js';

export interface PackageLocalRuntimeBackgroundAgentManagerPort {
  [operation: string]: unknown;
}

export interface PackageLocalAgentRuntimeDeps {
  executionPipeline: unknown;
  defaultContext: RuntimeContext;
  mcpRegistry: unknown;
  subagentRegistry: unknown;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  runtimeManaged: true;
  logger: unknown;
}

export interface PackageLocalAgentRuntimeDepsOptions {
  executionPipeline: unknown;
  defaultContext: RuntimeContext;
  mcpRegistry: unknown;
  subagentRegistry: unknown;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  logger: unknown;
}

export interface PackageLocalAgentRuntimeDepsOperations {
  get(): PackageLocalAgentRuntimeDeps;
}

export interface PackageLocalAgentRuntimeDepsOperationsOptions
  extends Omit<PackageLocalAgentRuntimeDepsOptions, 'executionPipeline'> {
  createExecutionPipeline(): unknown;
  getDefaultContext?: () => RuntimeContext;
}

export function createPackageLocalAgentRuntimeDepsOperations(
  options: PackageLocalAgentRuntimeDepsOperationsOptions,
): PackageLocalAgentRuntimeDepsOperations {
  return {
    get() {
      return createPackageLocalAgentRuntimeDeps({
        executionPipeline: options.createExecutionPipeline(),
        defaultContext: options.getDefaultContext?.() ?? options.defaultContext,
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
