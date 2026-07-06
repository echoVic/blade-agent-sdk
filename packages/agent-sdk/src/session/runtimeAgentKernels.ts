import type {
  AgentToolCall,
  AgentHookPort,
  AgentKernelOptions,
  AgentStorePort,
  AgentStreamEvent,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type { BladeConfig } from '../types/common.js';
import {
  resolvePackageLocalRuntimeKernelModel,
  type PackageLocalRuntimeKernelModelOptions,
  type PackageLocalRuntimeKernelModelResolverPort,
  type PackageLocalRuntimeResolvedKernelModel,
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

export interface PackageLocalRuntimeAgentKernelPortProjectionOptions {
  traceRecorder?: TraceRecorder;
  createExecutionContext?: (
    toolCall: AgentToolCall,
    signal?: AbortSignal,
  ) => ExecutionContext;
}

export interface PackageLocalRuntimeResolvedAgentKernelCreationOptions
  extends PackageLocalRuntimeAgentKernelCreationOptions,
    PackageLocalRuntimeAgentKernelPortProjectionOptions {}

export interface PackageLocalRuntimeAgentKernelOptions
  extends PackageLocalRuntimeResolvedAgentKernelCreationOptions,
    PackageLocalRuntimeKernelModelOptions {}

export interface ProjectPackageLocalRuntimeAgentKernelPortsOptions {
  options: PackageLocalRuntimeAgentKernelPortProjectionOptions;
  kernelModel: PackageLocalRuntimeResolvedKernelModel;
  getStorePort(): AgentStorePort;
  getHookPort(): AgentHookPort;
  getTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort;
  getToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort;
}

export function projectPackageLocalRuntimeAgentKernelPorts(
  options: ProjectPackageLocalRuntimeAgentKernelPortsOptions,
): PackageLocalRuntimeAgentKernelPorts {
  return {
    store: options.getStorePort(),
    hooks: options.getHookPort(),
    ...(options.options.traceRecorder
      ? {
          trace: options.getTracePort(
            options.options.traceRecorder,
            options.kernelModel.modelRequestDefaults?.maxContextTokens,
          ),
        }
      : {}),
    ...(options.options.createExecutionContext
      ? { tools: options.getToolPort(options.options.createExecutionContext) }
      : {}),
  };
}

export interface CreatePackageLocalRuntimeAgentKernelFromResolvedOptions {
  options: PackageLocalRuntimeResolvedAgentKernelCreationOptions;
  kernelModel: PackageLocalRuntimeResolvedKernelModel;
  kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort;
  getStorePort(): AgentStorePort;
  getHookPort(): AgentHookPort;
  getTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort;
  getToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort;
}

export function createPackageLocalRuntimeAgentKernelFromResolved(
  options: CreatePackageLocalRuntimeAgentKernelFromResolvedOptions,
): PackageLocalRuntimeAgentKernelPort {
  return createPackageLocalRuntimeAgentKernel({
    options: options.options,
    kernelModel: options.kernelModel,
    kernelFactory: options.kernelFactory,
    ports: projectPackageLocalRuntimeAgentKernelPorts({
      options: options.options,
      kernelModel: options.kernelModel,
      getStorePort: options.getStorePort,
      getHookPort: options.getHookPort,
      getTracePort: options.getTracePort,
      getToolPort: options.getToolPort,
    }),
  });
}

export type PackageLocalRuntimeResolvedAgentKernelCreator = (
  options: PackageLocalRuntimeResolvedAgentKernelCreationOptions,
  kernelModel: PackageLocalRuntimeResolvedKernelModel,
) => PackageLocalRuntimeAgentKernelPort;

export interface CreatePackageLocalRuntimeResolvedAgentKernelCreatorOptions
  extends Omit<CreatePackageLocalRuntimeAgentKernelFromResolvedOptions, 'options' | 'kernelModel'> {}

export function createPackageLocalRuntimeResolvedAgentKernelCreator(
  options: CreatePackageLocalRuntimeResolvedAgentKernelCreatorOptions,
): PackageLocalRuntimeResolvedAgentKernelCreator {
  return (agentKernelOptions, kernelModel) =>
    createPackageLocalRuntimeAgentKernelFromResolved({
      options: agentKernelOptions,
      kernelModel,
      kernelFactory: options.kernelFactory,
      getStorePort: options.getStorePort,
      getHookPort: options.getHookPort,
      getTracePort: options.getTracePort,
      getToolPort: options.getToolPort,
    });
}

export interface CreatePackageLocalRuntimeAgentKernelFromOptionsOptions
  extends Omit<CreatePackageLocalRuntimeAgentKernelFromResolvedOptions, 'kernelModel'> {
  options: PackageLocalRuntimeAgentKernelOptions;
  bladeConfig: BladeConfig;
  kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
}

export function createPackageLocalRuntimeAgentKernelFromOptions(
  options: CreatePackageLocalRuntimeAgentKernelFromOptionsOptions,
): PackageLocalRuntimeAgentKernelPort {
  const kernelModel = resolvePackageLocalRuntimeKernelModel({
    options: options.options,
    bladeConfig: options.bladeConfig,
    kernelModelResolver: options.kernelModelResolver,
  });

  return createPackageLocalRuntimeAgentKernelFromResolved({
    options: options.options,
    kernelModel,
    kernelFactory: options.kernelFactory,
    getStorePort: options.getStorePort,
    getHookPort: options.getHookPort,
    getTracePort: options.getTracePort,
    getToolPort: options.getToolPort,
  });
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
