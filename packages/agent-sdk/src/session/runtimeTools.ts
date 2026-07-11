import {
  createPackageLocalRuntimeToolFilterOperations,
  type PackageLocalRuntimeToolFilterOperations,
  type PackageLocalRuntimeToolFilterOptions,
} from './runtimeToolFilters.js';
import {
  createPackageLocalRuntimeSessionToolRegistrationOperations,
  createPackageLocalRuntimeToolRegistrationOperations,
  type PackageLocalRuntimeBuiltinToolProviderPort,
  type PackageLocalRuntimeCustomToolFactoryPort,
  type PackageLocalRuntimeCustomToolSource,
  type PackageLocalRuntimeBuiltinToolSource,
  type PackageLocalRuntimeConfiguredTool,
  type PackageLocalRuntimeNamedTool,
  type PackageLocalRuntimeSessionToolRegistrationOperations,
  type PackageLocalRuntimeToolRegistrationCatalogPort,
  type PackageLocalRuntimeToolRegistrationOperations,
} from './runtimeToolRegistration.js';

export interface PackageLocalRuntimeToolOperationsOptions<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
  TMcpRegistry,
> extends PackageLocalRuntimeToolFilterOptions {
  definitions?: readonly (PackageLocalRuntimeConfiguredTool | TTool)[];
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort<TTool>;
  sessionId: string;
  storageRoot?: string;
  mcpRegistry: TMcpRegistry;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort<TTool, TMcpRegistry>;
  toolCatalog: PackageLocalRuntimeToolRegistrationCatalogPort<TTool, TSource>;
  registerTools(
    tools: TTool[],
    source: PackageLocalRuntimeCustomToolSource | PackageLocalRuntimeBuiltinToolSource,
  ): void;
}

export interface PackageLocalRuntimeToolOperations<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
> {
  filter: PackageLocalRuntimeToolFilterOperations;
  registration: PackageLocalRuntimeToolRegistrationOperations<TTool, TSource>;
  sessionRegistration: PackageLocalRuntimeSessionToolRegistrationOperations;
}

export function createPackageLocalRuntimeToolOperations<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
  TMcpRegistry,
>(
  options: PackageLocalRuntimeToolOperationsOptions<TTool, TSource, TMcpRegistry>,
): PackageLocalRuntimeToolOperations<TTool, TSource> {
  const filter = createPackageLocalRuntimeToolFilterOperations({
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  });

  return {
    filter,
    registration: createPackageLocalRuntimeToolRegistrationOperations({
      filterTools: (tools) => filter.filter(tools),
      toolCatalog: options.toolCatalog,
    }),
    sessionRegistration: createPackageLocalRuntimeSessionToolRegistrationOperations({
      definitions: options.definitions,
      customToolFactory: options.customToolFactory,
      sessionId: options.sessionId,
      storageRoot: options.storageRoot,
      mcpRegistry: options.mcpRegistry,
      builtinToolProvider: options.builtinToolProvider,
      registerTools: options.registerTools,
    }),
  };
}
