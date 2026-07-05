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

export interface PackageLocalRuntimeCustomToolRegistrationOptions<
  TTool extends PackageLocalRuntimeNamedTool,
> {
  definitions?: readonly PackageLocalRuntimeToolDefinition[];
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort<TTool>;
  registerTools(tools: TTool[], source: PackageLocalRuntimeCustomToolSource): void;
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
