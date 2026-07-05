import type {
  AgentHookPort,
  AgentKernelOptions,
  AgentStorePort,
  AgentStreamEvent,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import type {
  PackageLocalRuntimeResolvedKernelModel,
} from './runtimeKernelModels.js';

export type { PackageLocalRuntimeResolvedKernelModel } from './runtimeKernelModels.js';

export interface PackageLocalRuntimeAgentKernelCreationOptions {
  maxSteps?: number;
}

export interface PackageLocalRuntimeAgentKernelTurn {
  input: string;
  turnId?: string;
  signal?: AbortSignal;
}

export interface PackageLocalRuntimeAgentKernelPort {
  runTurn(turn: PackageLocalRuntimeAgentKernelTurn): AsyncIterable<AgentStreamEvent>;
}

export interface PackageLocalRuntimeAgentKernelFactoryPort {
  create(options: AgentKernelOptions): PackageLocalRuntimeAgentKernelPort;
}

export interface PackageLocalRuntimeAgentKernelPorts {
  store: AgentStorePort;
  hooks: AgentHookPort;
  trace?: AgentTracePort;
  tools?: AgentToolPort;
}

export interface CreatePackageLocalRuntimeAgentKernelOptions {
  options: PackageLocalRuntimeAgentKernelCreationOptions;
  kernelModel: PackageLocalRuntimeResolvedKernelModel;
  kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort;
  ports: PackageLocalRuntimeAgentKernelPorts;
}

export function createPackageLocalRuntimeAgentKernel(
  options: CreatePackageLocalRuntimeAgentKernelOptions,
): PackageLocalRuntimeAgentKernelPort {
  return options.kernelFactory.create({
    model: options.kernelModel.model,
    ...(options.kernelModel.modelRequestDefaults
      ? { modelRequestDefaults: options.kernelModel.modelRequestDefaults }
      : {}),
    store: options.ports.store,
    hooks: options.ports.hooks,
    ...(options.ports.trace ? { trace: options.ports.trace } : {}),
    ...(options.ports.tools ? { tools: options.ports.tools } : {}),
    ...(options.options.maxSteps !== undefined ? { maxSteps: options.options.maxSteps } : {}),
  });
}
