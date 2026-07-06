import {
  createPackageLocalRuntimeMcpCapabilityOperations,
  type PackageLocalRuntimeMcpCapabilityOperations,
  type PackageLocalRuntimeMcpCapabilityRegistryPort,
} from './runtimeMcpCapabilities.js';
import {
  createPackageLocalRuntimeMcpServerOperations,
  type PackageLocalRuntimeMcpServerOperations,
  type PackageLocalRuntimeMcpServerOperationsOptions,
} from './runtimeMcpServers.js';
import {
  createPackageLocalRuntimeMcpToolRefreshOperations,
  type PackageLocalRuntimeMcpTool,
  type PackageLocalRuntimeMcpToolCatalogPort,
  type PackageLocalRuntimeMcpToolRefreshOperations,
  type PackageLocalRuntimeMcpToolRegistryPort,
} from './runtimeMcpTools.js';

export interface PackageLocalRuntimeMcpOperationsOptions<
  TTool extends PackageLocalRuntimeMcpTool,
> extends Omit<PackageLocalRuntimeMcpServerOperationsOptions, 'mcpRegistry'> {
  mcpRegistry: PackageLocalRuntimeMcpCapabilityRegistryPort &
    PackageLocalRuntimeMcpServerOperationsOptions['mcpRegistry'] &
    PackageLocalRuntimeMcpToolRegistryPort<TTool>;
  toolCatalog: PackageLocalRuntimeMcpToolCatalogPort<TTool>;
  filterTools(tools: TTool[]): TTool[];
}

export interface PackageLocalRuntimeMcpOperations {
  capabilities: PackageLocalRuntimeMcpCapabilityOperations;
  servers: PackageLocalRuntimeMcpServerOperations;
  tools: PackageLocalRuntimeMcpToolRefreshOperations;
}

export function createPackageLocalRuntimeMcpOperations<
  TTool extends PackageLocalRuntimeMcpTool,
>(options: PackageLocalRuntimeMcpOperationsOptions<TTool>): PackageLocalRuntimeMcpOperations {
  return {
    capabilities: createPackageLocalRuntimeMcpCapabilityOperations({
      mcpRegistry: options.mcpRegistry,
    }),
    servers: createPackageLocalRuntimeMcpServerOperations({
      configuredServers: options.configuredServers,
      mcpRegistry: options.mcpRegistry,
      logger: options.logger,
      refreshMcpTools: options.refreshMcpTools,
    }),
    tools: createPackageLocalRuntimeMcpToolRefreshOperations({
      mcpRegistry: options.mcpRegistry,
      toolCatalog: options.toolCatalog,
      filterTools: options.filterTools,
    }),
  };
}
