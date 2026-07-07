import type {
  PackageLocalRuntimeResolvedPorts,
} from './runtimeNoopPorts.js';
import type {
  PackageLocalSessionRuntimeOptions,
  PackageLocalRuntimeBuiltinToolProviderPort,
  PackageLocalRuntimeCustomToolFactoryPort,
  PackageLocalRuntimeLoggerPort,
  PackageLocalRuntimeMcpRegistryPort,
  PackageLocalRuntimeSessionStorePort,
  PackageLocalRuntimeSubagentRegistryPort,
  PackageLocalRuntimeToolCatalogPort,
  PackageLocalRuntimeWorkspacePort,
} from './runtimePorts.js';
import type {
  PackageLocalRuntimeBackgroundAgentManagerPort,
} from './runtimeAgentDeps.js';
import type {
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import type {
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
} from './runtimeKernelModels.js';
import type {
  PackageLocalRuntimeKernelPortFactoryPort,
} from './runtimeKernelPorts.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
} from './runtimeAgentKernels.js';
import type {
  PackageLocalRuntimePermissionHookPort,
} from './runtimePermissions.js';

export interface PackageLocalRuntimePortProjectionOptions {
  ports: PackageLocalRuntimeResolvedPorts;
  options: Pick<
    PackageLocalSessionRuntimeOptions,
    'customToolFactory' | 'builtinToolProvider'
  >;
}

export interface PackageLocalRuntimePortFields {
  sessionStore: PackageLocalRuntimeSessionStorePort;
  workspace: PackageLocalRuntimeWorkspacePort;
  mcpRegistry: PackageLocalRuntimeMcpRegistryPort;
  toolCatalog: PackageLocalRuntimeToolCatalogPort;
  logger: PackageLocalRuntimeLoggerPort;
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort;
  subagentRegistry: PackageLocalRuntimeSubagentRegistryPort;
  permissionHooks: PackageLocalRuntimePermissionHookPort;
  hookManager: PackageLocalRuntimeHookManagerPort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  executionPipelineFactory: PackageLocalRuntimeExecutionPipelineFactoryPort;
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
  kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort;
  kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
}

export function projectPackageLocalRuntimePortFields(
  options: PackageLocalRuntimePortProjectionOptions,
): PackageLocalRuntimePortFields {
  return {
    sessionStore: options.ports.sessionStore,
    workspace: options.ports.workspace,
    mcpRegistry: options.ports.mcpRegistry,
    toolCatalog: options.ports.toolCatalog,
    logger: options.ports.logger,
    customToolFactory: options.options.customToolFactory,
    builtinToolProvider: options.options.builtinToolProvider,
    subagentRegistry: options.ports.subagentRegistry,
    permissionHooks: options.ports.permissionHooks,
    hookManager: options.ports.hookManager,
    hookRuntime: options.ports.hookRuntime,
    backgroundAgentManager: options.ports.backgroundAgentManager,
    executionPipelineFactory: options.ports.executionPipelineFactory,
    kernelPortFactory: options.ports.kernelPortFactory,
    kernelFactory: options.ports.kernelFactory,
    kernelModelResolver: options.ports.kernelModelResolver,
  };
}
