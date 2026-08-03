import type { Tool, ToolDefinition } from '../tools/types/index.js';
import type { SessionId, SessionOptions, SessionTool } from './types.js';

export interface PackageLocalRuntimeNamedTool {
  name: string;
}

export type PackageLocalRuntimeConfiguredTool = NonNullable<SessionOptions['tools']>[number];
export type PackageLocalRuntimeToolDefinition = Extract<SessionTool, ToolDefinition<never>>;

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
  definitions?: readonly (PackageLocalRuntimeToolDefinition | TTool)[];
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort<TTool>;
  registerTools(tools: TTool[], source: PackageLocalRuntimeCustomToolSource): void;
}

export interface PackageLocalRuntimeBuiltinToolContext<TMcpRegistry> {
  sessionId: SessionId;
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
  sessionId: SessionId;
  storageRoot?: string;
  mcpRegistry: TMcpRegistry;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort<TTool, TMcpRegistry>;
  registerTools(tools: TTool[], source: PackageLocalRuntimeBuiltinToolSource): void;
}

export interface PackageLocalRuntimeSessionToolRegistrationOperations {
  registerCustomTools(): void;
  registerBuiltinTools(): Promise<void>;
}

export interface PackageLocalRuntimeSessionToolRegistrationOperationsOptions<
  TTool extends PackageLocalRuntimeNamedTool,
  TMcpRegistry,
> {
  definitions?: readonly (PackageLocalRuntimeToolDefinition | TTool)[];
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort<TTool>;
  sessionId: SessionId;
  storageRoot?: string;
  mcpRegistry: TMcpRegistry;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort<TTool, TMcpRegistry>;
  registerTools(
    tools: TTool[],
    source: PackageLocalRuntimeCustomToolSource | PackageLocalRuntimeBuiltinToolSource,
  ): void;
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

export function createPackageLocalRuntimeSessionToolRegistrationOperations<
  TTool extends PackageLocalRuntimeNamedTool,
  TMcpRegistry,
>(
  options: PackageLocalRuntimeSessionToolRegistrationOperationsOptions<TTool, TMcpRegistry>,
): PackageLocalRuntimeSessionToolRegistrationOperations {
  return {
    registerCustomTools() {
      registerPackageLocalRuntimeCustomTools({
        definitions: options.definitions,
        customToolFactory: options.customToolFactory,
        registerTools: options.registerTools,
      });
    },
    registerBuiltinTools() {
      return registerPackageLocalRuntimeBuiltinTools({
        sessionId: options.sessionId,
        storageRoot: options.storageRoot,
        mcpRegistry: options.mcpRegistry,
        builtinToolProvider: options.builtinToolProvider,
        registerTools: options.registerTools,
      });
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

  const tools = definitions.map((definition) => {
    if (isPackageLocalRuntimeToolDefinition(definition)) {
      if (!options.customToolFactory) {
        throw new Error('Package-local custom tool factory port is required to register tools');
      }
      return options.customToolFactory.fromDefinition(definition);
    }
    return definition;
  });
  options.registerTools(tools, {
    kind: 'custom',
    trustLevel: 'workspace',
    sourceId: 'session',
  });
}

function isPackageLocalRuntimeToolDefinition<TTool extends PackageLocalRuntimeNamedTool>(
  value: PackageLocalRuntimeToolDefinition | TTool,
): value is PackageLocalRuntimeToolDefinition {
  if ('parameters' in value) {
    return true;
  }

  const candidate = value as Partial<Tool>;
  return !(
    typeof candidate.getFunctionDeclaration === 'function'
    && typeof candidate.build === 'function'
    && typeof candidate.execute === 'function'
  );
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
