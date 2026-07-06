export interface PackageLocalRuntimeNamedTool {
  name: string;
}

export interface PackageLocalRuntimeMcpTool extends PackageLocalRuntimeNamedTool {
  tags?: readonly string[];
}

export interface PackageLocalRuntimeMcpToolSource {
  kind: 'mcp';
  trustLevel: 'remote';
  sourceId: string;
}

export interface PackageLocalRuntimeMcpToolRegistryPort<TTool extends PackageLocalRuntimeMcpTool> {
  getAvailableToolsByServerNames?(serverNames: string[]): Promise<TTool[]>;
}

export interface PackageLocalRuntimeMcpToolCatalogPort<TTool extends PackageLocalRuntimeMcpTool> {
  removeMcpTools(serverName: string): number;
  registerMcpTool<TRegisteredTool extends TTool>(
    tool: TRegisteredTool,
    source: PackageLocalRuntimeMcpToolSource,
  ): void;
}

export interface PackageLocalRuntimeMcpToolRefreshOptions<
  TTool extends PackageLocalRuntimeMcpTool,
> {
  serverNames: readonly string[];
  mcpRegistry: PackageLocalRuntimeMcpToolRegistryPort<TTool>;
  toolCatalog: PackageLocalRuntimeMcpToolCatalogPort<TTool>;
  filterTools(tools: TTool[]): TTool[];
}

export interface PackageLocalRuntimeMcpToolRefreshOperations {
  refresh(serverNames: readonly string[]): Promise<void>;
}

export type PackageLocalRuntimeMcpToolRefreshOperationsOptions<
  TTool extends PackageLocalRuntimeMcpTool,
> = Omit<PackageLocalRuntimeMcpToolRefreshOptions<TTool>, 'serverNames'>;

export function getPackageLocalMcpToolSourceId(tool: PackageLocalRuntimeMcpTool): string {
  const taggedServer = tool.tags?.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}

export async function refreshPackageLocalRuntimeMcpTools<
  TTool extends PackageLocalRuntimeMcpTool,
>(options: PackageLocalRuntimeMcpToolRefreshOptions<TTool>): Promise<void> {
  const serverNames = [...options.serverNames];
  for (const serverName of serverNames) {
    options.toolCatalog.removeMcpTools(serverName);
  }

  const availableTools =
    (await options.mcpRegistry.getAvailableToolsByServerNames?.(serverNames)) ?? [];
  for (const tool of options.filterTools(availableTools)) {
    options.toolCatalog.registerMcpTool(tool, {
      kind: 'mcp',
      trustLevel: 'remote',
      sourceId: getPackageLocalMcpToolSourceId(tool),
    });
  }
}

export function createPackageLocalRuntimeMcpToolRefreshOperations<
  TTool extends PackageLocalRuntimeMcpTool,
>(
  options: PackageLocalRuntimeMcpToolRefreshOperationsOptions<TTool>,
): PackageLocalRuntimeMcpToolRefreshOperations {
  return {
    refresh(serverNames) {
      return refreshPackageLocalRuntimeMcpTools({
        serverNames,
        mcpRegistry: options.mcpRegistry,
        toolCatalog: options.toolCatalog,
        filterTools: options.filterTools,
      });
    },
  };
}
