import type { McpServerConfig } from '../types/common.js';
import type { SdkMcpServerHandle } from './types.js';

interface PackageLocalMcpRegistryActionPort {
  disconnectAll?(): Promise<void> | void;
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

export interface PackageLocalRuntimeMcpServerRegistrationOperations {
  registerConfigured(): Promise<void>;
}

export type PackageLocalRuntimeMcpServerRegistrationOperationsOptions =
  PackageLocalConfiguredMcpServersRegistrationOptions;

export interface PackageLocalMcpServerEnsureOptions {
  serverName: string;
  configuredServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  mcpRegistry: PackageLocalMcpRegistryActionPort;
}

export interface PackageLocalMcpServerConnectOptions extends PackageLocalMcpServerEnsureOptions {
  refreshMcpTools(serverNames: string[]): Promise<void> | void;
}

export interface PackageLocalMcpServerDisconnectOptions {
  serverName: string;
  mcpRegistry: PackageLocalMcpRegistryActionPort;
  refreshMcpTools(serverNames: string[]): Promise<void> | void;
}

export interface PackageLocalMcpServerCloseOptions {
  mcpRegistry: PackageLocalMcpRegistryActionPort;
}

export interface PackageLocalRuntimeMcpServerLifecycleOperations {
  close(): Promise<void>;
  connect(serverName: string): Promise<void>;
  disconnect(serverName: string): Promise<void>;
  reconnect(serverName: string): Promise<void>;
}

export interface PackageLocalRuntimeMcpServerLifecycleOperationsOptions {
  configuredServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  mcpRegistry: PackageLocalMcpRegistryActionPort;
  refreshMcpTools(serverNames: string[]): Promise<void> | void;
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

export function createPackageLocalRuntimeMcpServerRegistrationOperations(
  options: PackageLocalRuntimeMcpServerRegistrationOperationsOptions,
): PackageLocalRuntimeMcpServerRegistrationOperations {
  return {
    registerConfigured() {
      return registerPackageLocalConfiguredMcpServers(options);
    },
  };
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

export async function closePackageLocalRuntimeMcpServers(
  options: PackageLocalMcpServerCloseOptions,
): Promise<void> {
  await options.mcpRegistry.disconnectAll?.call(options.mcpRegistry);
}

export async function connectPackageLocalRuntimeMcpServer(
  options: PackageLocalMcpServerConnectOptions,
): Promise<void> {
  await ensurePackageLocalMcpServerRegistered(options);
  await callPackageLocalMcpRegistryAction(options.mcpRegistry, 'connectServer', options.serverName);
  await options.refreshMcpTools([options.serverName]);
}

export async function disconnectPackageLocalRuntimeMcpServer(
  options: PackageLocalMcpServerDisconnectOptions,
): Promise<void> {
  await callPackageLocalMcpRegistryAction(
    options.mcpRegistry,
    'disconnectServer',
    options.serverName,
  );
  await options.refreshMcpTools([options.serverName]);
}

export async function reconnectPackageLocalRuntimeMcpServer(
  options: PackageLocalMcpServerConnectOptions,
): Promise<void> {
  await ensurePackageLocalMcpServerRegistered(options);
  await callPackageLocalMcpRegistryAction(
    options.mcpRegistry,
    'reconnectServer',
    options.serverName,
  );
  await options.refreshMcpTools([options.serverName]);
}

export function createPackageLocalRuntimeMcpServerLifecycleOperations(
  options: PackageLocalRuntimeMcpServerLifecycleOperationsOptions,
): PackageLocalRuntimeMcpServerLifecycleOperations {
  return {
    close() {
      return closePackageLocalRuntimeMcpServers({
        mcpRegistry: options.mcpRegistry,
      });
    },
    connect(serverName) {
      return connectPackageLocalRuntimeMcpServer({
        serverName,
        configuredServers: options.configuredServers,
        mcpRegistry: options.mcpRegistry,
        refreshMcpTools: options.refreshMcpTools,
      });
    },
    disconnect(serverName) {
      return disconnectPackageLocalRuntimeMcpServer({
        serverName,
        mcpRegistry: options.mcpRegistry,
        refreshMcpTools: options.refreshMcpTools,
      });
    },
    reconnect(serverName) {
      return reconnectPackageLocalRuntimeMcpServer({
        serverName,
        configuredServers: options.configuredServers,
        mcpRegistry: options.mcpRegistry,
        refreshMcpTools: options.refreshMcpTools,
      });
    },
  };
}
