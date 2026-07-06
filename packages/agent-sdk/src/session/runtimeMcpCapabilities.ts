import type { McpServerStatus, McpToolInfo } from './types.js';

export interface PackageLocalRuntimeMcpToolCapability {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface PackageLocalRuntimeMcpServerCapability {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  connectedAt?: Date;
  error?: string;
  auth: {
    enabled: boolean;
    provider?: string;
  };
  health: {
    enabled: boolean;
    status: 'healthy' | 'degraded' | 'unhealthy' | 'checking' | 'disabled' | 'unknown';
  };
  tools: PackageLocalRuntimeMcpToolCapability[];
}

export interface PackageLocalRuntimeMcpCapabilityRegistryPort {
  getCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]>;
}

export interface PackageLocalRuntimeMcpCapabilityOperations {
  getCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]>;
  getServerStatus(): Promise<McpServerStatus[]>;
  listTools(): Promise<McpToolInfo[]>;
}

export interface PackageLocalRuntimeMcpCapabilityOperationsOptions {
  mcpRegistry: PackageLocalRuntimeMcpCapabilityRegistryPort;
}

export function createPackageLocalRuntimeMcpCapabilityOperations(
  options: PackageLocalRuntimeMcpCapabilityOperationsOptions,
): PackageLocalRuntimeMcpCapabilityOperations {
  return {
    getCapabilities() {
      return options.mcpRegistry.getCapabilities();
    },
    async getServerStatus() {
      return projectPackageLocalRuntimeMcpServerStatus(
        await options.mcpRegistry.getCapabilities(),
      );
    },
    async listTools() {
      return listPackageLocalRuntimeMcpTools(await options.mcpRegistry.getCapabilities());
    },
  };
}

export function projectPackageLocalRuntimeMcpServerStatus(
  capabilities: readonly PackageLocalRuntimeMcpServerCapability[],
): McpServerStatus[] {
  return capabilities.map((capability) => ({
    name: capability.name,
    status: capability.status,
    toolCount: capability.tools.length,
    tools: capability.tools.map((tool) => tool.name),
    connectedAt: capability.connectedAt,
    error: capability.error,
  }));
}

export function listPackageLocalRuntimeMcpTools(
  capabilities: readonly PackageLocalRuntimeMcpServerCapability[],
): McpToolInfo[] {
  return capabilities.flatMap((capability) =>
    capability.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      serverName: capability.name,
    })),
  );
}
