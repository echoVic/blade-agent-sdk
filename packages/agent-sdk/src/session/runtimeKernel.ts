import {
  createPackageLocalRuntimeAgentKernelOperations,
  type CreatePackageLocalRuntimeAgentKernelOperationsOptions,
  type PackageLocalRuntimeAgentKernelOperations,
} from './runtimeAgentKernels.js';
import {
  createPackageLocalRuntimeKernelPortOperations,
  type CreatePackageLocalRuntimeKernelPortOperationsOptions,
  type PackageLocalRuntimeKernelPortOperations,
} from './runtimeKernelPorts.js';

export interface PackageLocalRuntimeKernelOperations {
  ports: PackageLocalRuntimeKernelPortOperations;
  agentKernel: PackageLocalRuntimeAgentKernelOperations;
}

export interface CreatePackageLocalRuntimeKernelOperationsOptions
  extends Omit<
      CreatePackageLocalRuntimeAgentKernelOperationsOptions,
      'getStorePort' | 'getHookPort' | 'getTracePort' | 'getToolPort'
    >,
    CreatePackageLocalRuntimeKernelPortOperationsOptions {}

export function createPackageLocalRuntimeKernelOperations(
  options: CreatePackageLocalRuntimeKernelOperationsOptions,
): PackageLocalRuntimeKernelOperations {
  const ports = createPackageLocalRuntimeKernelPortOperations(options);

  return {
    ports,
    agentKernel: createPackageLocalRuntimeAgentKernelOperations({
      bladeConfig: options.bladeConfig,
      kernelModelResolver: options.kernelModelResolver,
      kernelFactory: options.kernelFactory,
      getStorePort: () => ports.createStorePort(),
      getHookPort: () => ports.createHookPort(),
      getTracePort: (recorder, maxContextTokens) =>
        ports.createTracePort(recorder, maxContextTokens),
      getToolPort: (createExecutionContext) => ports.createToolPort(createExecutionContext),
    }),
  };
}
