import {
  createPackageLocalRuntimeKernelTurnStreamOperations,
  type PackageLocalRuntimeKernelTurnResolutionOptions,
  type PackageLocalRuntimeKernelTurnStreamOperations,
} from './runtimeKernelTurnStream.js';
import {
  createPackageLocalRuntimeTraceRuntime,
  type PackageLocalRuntimeTraceManagerOptions,
  type PackageLocalRuntimeTraceOperations,
} from './runtimeTraceManager.js';
import type { SessionTraceManager } from './traces.js';

export interface PackageLocalRuntimeTurnOperations {
  traceManager: SessionTraceManager;
  traceOperations: PackageLocalRuntimeTraceOperations;
  kernelTurnStream: PackageLocalRuntimeKernelTurnStreamOperations;
}

export interface CreatePackageLocalRuntimeTurnOperationsOptions
  extends PackageLocalRuntimeTraceManagerOptions,
    Omit<
      PackageLocalRuntimeKernelTurnResolutionOptions,
      'sessionId' | 'streamOptions' | 'traceManager'
    > {}

export function createPackageLocalRuntimeTurnOperations(
  options: CreatePackageLocalRuntimeTurnOperationsOptions,
): PackageLocalRuntimeTurnOperations {
  const traceRuntime = createPackageLocalRuntimeTraceRuntime(options);

  return {
    traceManager: traceRuntime.traceManager,
    traceOperations: traceRuntime.traceOperations,
    kernelTurnStream: createPackageLocalRuntimeKernelTurnStreamOperations({
      sessionId: options.sessionId,
      bladeConfig: options.bladeConfig,
      traceManager: traceRuntime.traceManager,
      hookRuntime: options.hookRuntime,
      kernelModelResolver: options.kernelModelResolver,
      createAgentKernel: options.createAgentKernel,
    }),
  };
}
