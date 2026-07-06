import {
  createPackageLocalRuntimeForkOperations,
  type PackageLocalRuntimeForkOperations,
  type PackageLocalRuntimeForkOptions,
} from './runtimeForking.js';
import {
  createPackageLocalRuntimeSubagentOperations,
  type PackageLocalRuntimeSubagentInitializationOptions,
  type PackageLocalRuntimeSubagentOperations,
} from './runtimeSubagents.js';

export interface PackageLocalRuntimeSessionCapabilityOperations {
  subagents: PackageLocalRuntimeSubagentOperations;
  fork: PackageLocalRuntimeForkOperations;
}

export interface CreatePackageLocalRuntimeSessionCapabilityOperationsOptions
  extends Omit<PackageLocalRuntimeForkOptions, 'forkOptions'>,
    Omit<PackageLocalRuntimeSubagentInitializationOptions, 'agents'> {}

export function createPackageLocalRuntimeSessionCapabilityOperations(
  options: CreatePackageLocalRuntimeSessionCapabilityOperationsOptions,
): PackageLocalRuntimeSessionCapabilityOperations {
  return {
    subagents: createPackageLocalRuntimeSubagentOperations({
      subagentRegistry: options.subagentRegistry,
      logger: options.logger,
      projectPath: options.projectPath,
      storageRoot: options.storageRoot,
      agents: options.options.agents,
    }),
    fork: createPackageLocalRuntimeForkOperations({
      sessionId: options.sessionId,
      options: options.options,
      sessionStore: options.sessionStore,
      createForkSessionId: options.createForkSessionId,
      createForkSession: options.createForkSession,
    }),
  };
}
