import type { SessionOptions } from './types.js';

export interface PackageLocalRuntimeNamedTool {
  name: string;
}

export type PackageLocalRuntimeToolDefinition = NonNullable<SessionOptions['tools']>[number];

export interface PackageLocalRuntimeCustomToolFactoryPort<
  TTool extends PackageLocalRuntimeNamedTool,
> {
  fromDefinition(definition: PackageLocalRuntimeToolDefinition): TTool;
}

export interface PackageLocalRuntimeCustomToolSource {
  kind: 'custom';
  trustLevel: 'workspace';
  sourceId: 'session';
}

export interface PackageLocalRuntimeBuiltinToolSource {
  kind: 'builtin';
  trustLevel: 'trusted';
  sourceId: 'builtin';
}

export interface PackageLocalRuntimeCustomToolRegistrationOptions<
  TTool extends PackageLocalRuntimeNamedTool,
> {
  definitions?: readonly PackageLocalRuntimeToolDefinition[];
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort<TTool>;
  registerTools(tools: TTool[], source: PackageLocalRuntimeCustomToolSource): void;
}

export interface PackageLocalRuntimeBuiltinToolContext<TMcpRegistry> {
  sessionId: string;
  configDir: string | undefined;
  mcpRegistry: TMcpRegistry;
  includeMcpProtocolTools: false;
}

export interface PackageLocalRuntimeBuiltinToolProviderPort<
  TTool extends PackageLocalRuntimeNamedTool,
  TMcpRegistry,
> {
  getTools(context: PackageLocalRuntimeBuiltinToolContext<TMcpRegistry>): Promise<TTool[]>;
}

export interface PackageLocalRuntimeBuiltinToolRegistrationOptions<
  TTool extends PackageLocalRuntimeNamedTool,
  TMcpRegistry,
> {
  sessionId: string;
  storageRoot?: string;
  mcpRegistry: TMcpRegistry;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort<TTool, TMcpRegistry>;
  registerTools(tools: TTool[], source: PackageLocalRuntimeBuiltinToolSource): void;
}

export interface PackageLocalRuntimeToolRegistrationCatalogPort<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
> {
  registerAll<TRegisteredTool extends TTool>(
    tools: TRegisteredTool[],
    source: TSource,
  ): void;
}

export interface PackageLocalRuntimeToolRegistrationOperations<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
> {
  registerTools<TRegisteredTool extends TTool>(
    tools: TRegisteredTool[],
    source: TSource,
  ): void;
}

export interface PackageLocalRuntimeToolRegistrationOperationsOptions<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
> {
  filterTools<TRegisteredTool extends TTool>(tools: TRegisteredTool[]): TRegisteredTool[];
  toolCatalog: PackageLocalRuntimeToolRegistrationCatalogPort<TTool, TSource>;
}

export function createPackageLocalRuntimeToolRegistrationOperations<
  TTool extends PackageLocalRuntimeNamedTool,
  TSource,
>(
  options: PackageLocalRuntimeToolRegistrationOperationsOptions<TTool, TSource>,
): PackageLocalRuntimeToolRegistrationOperations<TTool, TSource> {
  return {
    registerTools(tools, source) {
      const filteredTools = options.filterTools(tools);
      if (filteredTools.length === 0) {
        return;
      }

      options.toolCatalog.registerAll(filteredTools, source);
    },
  };
}

export function registerPackageLocalRuntimeCustomTools<
  TTool extends PackageLocalRuntimeNamedTool,
>(options: PackageLocalRuntimeCustomToolRegistrationOptions<TTool>): void {
  const definitions = options.definitions ?? [];
  if (definitions.length === 0) {
    return;
  }

  if (!options.customToolFactory) {
    throw new Error('Package-local custom tool factory port is required to register tools');
  }

  const customToolFactory = options.customToolFactory;
  const tools = definitions.map((definition) => customToolFactory.fromDefinition(definition));
  options.registerTools(tools, {
    kind: 'custom',
    trustLevel: 'workspace',
    sourceId: 'session',
  });
}

export async function registerPackageLocalRuntimeBuiltinTools<
  TTool extends PackageLocalRuntimeNamedTool,
  TMcpRegistry,
>(options: PackageLocalRuntimeBuiltinToolRegistrationOptions<TTool, TMcpRegistry>): Promise<void> {
  const tools =
    (await options.builtinToolProvider?.getTools({
      sessionId: options.sessionId,
      configDir: options.storageRoot,
      mcpRegistry: options.mcpRegistry,
      includeMcpProtocolTools: false,
    })) ?? [];

  options.registerTools(tools, {
    kind: 'builtin',
    trustLevel: 'trusted',
    sourceId: 'builtin',
  });
}
