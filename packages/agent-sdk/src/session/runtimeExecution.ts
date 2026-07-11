import {
  createPackageLocalAgentRuntimeDepsOperations,
  type PackageLocalAgentRuntimeDepsOperations,
  type PackageLocalAgentRuntimeDepsOperationsOptions,
} from './runtimeAgentDeps.js';
import {
  createPackageLocalRuntimeExecutionPipelineOperations,
  type PackageLocalRuntimeExecutionPipelineOperations,
  type PackageLocalRuntimeExecutionPipelineOperationsOptions,
} from './runtimeExecutionPipeline.js';

export interface PackageLocalRuntimeExecutionOperationsOptions
  extends Omit<
      PackageLocalAgentRuntimeDepsOperationsOptions,
      'createExecutionPipeline' | 'hookRuntime'
    >,
    Omit<PackageLocalRuntimeExecutionPipelineOperationsOptions, 'hookRuntime'> {
  hookRuntime: PackageLocalAgentRuntimeDepsOperationsOptions['hookRuntime'];
}

export interface PackageLocalRuntimeExecutionOperations {
  pipeline: PackageLocalRuntimeExecutionPipelineOperations;
  agentDeps: PackageLocalAgentRuntimeDepsOperations;
}

export function createPackageLocalRuntimeExecutionOperations(
  options: PackageLocalRuntimeExecutionOperationsOptions,
): PackageLocalRuntimeExecutionOperations {
  const pipeline = createPackageLocalRuntimeExecutionPipelineOperations(options);

  return {
    pipeline,
    agentDeps: createPackageLocalAgentRuntimeDepsOperations({
      createExecutionPipeline: () => pipeline.get(),
      defaultContext: options.defaultContext,
      getDefaultContext: options.getDefaultContext,
      mcpRegistry: options.mcpRegistry,
      subagentRegistry: options.subagentRegistry,
      backgroundAgentManager: options.backgroundAgentManager,
      hookRuntime: options.hookRuntime,
      logger: options.logger,
    }),
  };
}
