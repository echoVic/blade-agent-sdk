import {
  createPackageLocalRuntimeMcpOperations,
  type PackageLocalRuntimeMcpOperations,
  type PackageLocalRuntimeMcpOperationsOptions,
} from './runtimeMcp.js';
import type { PackageLocalRuntimeMcpTool } from './runtimeMcpTools.js';
import {
  createPackageLocalRuntimeSessionOperations,
  type PackageLocalRuntimeSessionOperations,
  type PackageLocalRuntimeSessionOperationsOptions,
} from './runtimeSessionOperations.js';

export interface PackageLocalRuntimeConnectionOperationsOptions<
  TMessage,
  TTool extends PackageLocalRuntimeMcpTool,
> extends Omit<PackageLocalRuntimeSessionOperationsOptions<TMessage>, 'closeRuntimeResources'>,
    PackageLocalRuntimeMcpOperationsOptions<TTool> {}

export interface PackageLocalRuntimeConnectionOperations<TMessage> {
  session: PackageLocalRuntimeSessionOperations<TMessage>;
  mcp: PackageLocalRuntimeMcpOperations;
}

export function createPackageLocalRuntimeConnectionOperations<
  TMessage,
  TTool extends PackageLocalRuntimeMcpTool,
>(
  options: PackageLocalRuntimeConnectionOperationsOptions<TMessage, TTool>,
): PackageLocalRuntimeConnectionOperations<TMessage> {
  const mcp = createPackageLocalRuntimeMcpOperations({
    configuredServers: options.configuredServers,
    mcpRegistry: options.mcpRegistry,
    logger: options.logger,
    toolCatalog: options.toolCatalog,
    filterTools: options.filterTools,
    refreshMcpTools: options.refreshMcpTools,
  });

  return {
    session: createPackageLocalRuntimeSessionOperations({
      sessionId: options.sessionId,
      sessionStore: options.sessionStore,
      workspace: options.workspace,
      hookRuntime: options.hookRuntime,
      model: options.model,
      provider: options.provider,
      closeRuntimeResources: () => mcp.servers.lifecycle.close(),
    }),
    mcp,
  };
}
