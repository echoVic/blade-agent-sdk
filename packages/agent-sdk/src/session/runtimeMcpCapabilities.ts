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
