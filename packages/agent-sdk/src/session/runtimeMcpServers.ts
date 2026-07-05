import type { McpServerConfig } from '../types/common.js';
import type { SdkMcpServerHandle } from './types.js';

interface PackageLocalMcpRegistryActionPort {
  connectServer?(serverName: string): Promise<void> | void;
  disconnectServer?(serverName: string): Promise<void> | void;
  reconnectServer?(serverName: string): Promise<void> | void;
  registerInProcessServer?(
    serverName: string,
    config: SdkMcpServerHandle,
  ): Promise<void> | void;
  registerServer?(serverName: string, config: McpServerConfig): Promise<void> | void;
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
