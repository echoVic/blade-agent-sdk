import type { PackageLocalRuntimeResolvedPorts } from './runtimeNoopPorts.js';
import { resolvePackageLocalRuntimePorts } from './runtimeNoopPorts.js';
import type {
  PackageLocalRuntimeInitialState,
  PackageLocalRuntimeInitialStateOptions,
} from './runtimeState.js';
import { createPackageLocalRuntimeInitialState } from './runtimeState.js';
import type { PackageLocalSessionRuntimeOptions } from './runtimePorts.js';

export interface PackageLocalRuntimeBootstrapOptions
  extends PackageLocalSessionRuntimeOptions {}

export interface PackageLocalRuntimeBootstrap {
  initialState: PackageLocalRuntimeInitialState;
  ports: PackageLocalRuntimeResolvedPorts;
}

export function createPackageLocalRuntimeBootstrap(
  options: PackageLocalRuntimeBootstrapOptions,
): PackageLocalRuntimeBootstrap {
  const initialStateOptions: PackageLocalRuntimeInitialStateOptions = {
    options: options.options,
    bladeConfig: options.bladeConfig,
    defaultContext: options.defaultContext,
  };

  return {
    initialState: createPackageLocalRuntimeInitialState(initialStateOptions),
    ports: resolvePackageLocalRuntimePorts(options),
  };
}
