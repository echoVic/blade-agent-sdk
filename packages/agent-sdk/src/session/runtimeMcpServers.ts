import type { McpServerConfig } from '../types/common.js';
import type { SdkMcpServerHandle } from './types.js';

interface PackageLocalMcpRegistryActionPort {
  connectServer?(serverName: string): Promise<void> | void;
  disconnectServer?(serverName: string): Promise<void> | void;
  reconnectServer?(serverName: string): Promise<void> | void;
  ensureServerRegistered?(
    serverName: string,
    config: McpServerConfig | SdkMcpServerHandle,
  ): Promise<void> | void;
  registerInProcessServer?(
    serverName: string,
    config: SdkMcpServerHandle,
  ): Promise<void> | void;
  registerServer?(serverName: string, config: McpServerConfig): Promise<void> | void;
}

interface PackageLocalMcpLoggerPort {
  warn(...args: unknown[]): void;
}

export interface PackageLocalConfiguredMcpServersRegistrationOptions {
  configuredServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  mcpRegistry: PackageLocalMcpRegistryActionPort;
  logger: PackageLocalMcpLoggerPort;
  refreshMcpTools(serverNames: string[]): Promise<void> | void;
}

export interface PackageLocalMcpServerEnsureOptions {
  serverName: string;
  configuredServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  mcpRegistry: PackageLocalMcpRegistryActionPort;
}

export function isPackageLocalSdkMcpServerHandle(
  config: unknown,
): config is SdkMcpServerHandle {
  return (
    typeof config === 'object' &&
    config !== null &&
    'createClientTransport' in config &&
    'server' in config
  );
}

export async function callPackageLocalMcpRegistryAction(
  registry: PackageLocalMcpRegistryActionPort,
  method: 'connectServer' | 'disconnectServer' | 'reconnectServer',
  serverName: string,
): Promise<void> {
  const action = registry[method];
  if (!action) {
    throw new Error(`Package-local MCP registry port does not implement ${method}`);
  }
  await action.call(registry, serverName);
}

export async function registerPackageLocalInProcessMcpServer(
  registry: PackageLocalMcpRegistryActionPort,
  serverName: string,
  config: SdkMcpServerHandle,
): Promise<void> {
  const action = registry.registerInProcessServer;
  if (!action) {
    throw new Error('Package-local MCP registry port does not implement registerInProcessServer');
  }
  await action.call(registry, serverName, config);
}

export async function registerPackageLocalRemoteMcpServer(
  registry: PackageLocalMcpRegistryActionPort,
  serverName: string,
  config: McpServerConfig,
): Promise<void> {
  const action = registry.registerServer;
  if (!action) {
    throw new Error('Package-local MCP registry port does not implement registerServer');
  }
  await action.call(registry, serverName, config);
}

export async function registerPackageLocalConfiguredMcpServers(
  options: PackageLocalConfiguredMcpServersRegistrationOptions,
): Promise<void> {
  const configuredServers = options.configuredServers;
  if (!configuredServers) {
    return;
  }

  for (const [serverName, config] of Object.entries(configuredServers)) {
    if (isPackageLocalSdkMcpServerHandle(config)) {
      await registerPackageLocalInProcessMcpServer(options.mcpRegistry, serverName, config);
      continue;
    }

    if (config.disabled) {
      continue;
    }

    try {
      await registerPackageLocalRemoteMcpServer(options.mcpRegistry, serverName, config);
    } catch (error) {
      options.logger.warn(
        `[PackageLocalSessionRuntime] Failed to register MCP server ${serverName}:`,
        error,
      );
    }
  }

  await options.refreshMcpTools(Object.keys(configuredServers));
}

export async function ensurePackageLocalMcpServerRegistered(
  options: PackageLocalMcpServerEnsureOptions,
): Promise<void> {
  const config = options.configuredServers?.[options.serverName];
  if (!config) {
    throw new Error(`MCP server "${options.serverName}" not found in configuration`);
  }

  await options.mcpRegistry.ensureServerRegistered?.call(
    options.mcpRegistry,
    options.serverName,
    config,
  );
}
