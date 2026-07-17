import { HealthStatus } from './mcpHealth.js';
import { McpConnectionStatus, type McpToolDefinition } from './mcpTypes.js';

/**
 * Minimal interface for an MCP server info needed by the capability projector.
 * Decouples from the full McpServerInfo type defined in McpRegistry.
 */
export interface McpServerInfoForCapability {
  status: McpConnectionStatus;
  connectedAt?: Date;
  lastError?: Error;
  config: {
    oauth?: { enabled?: boolean; provider?: string };
    healthCheck?: { enabled?: boolean };
  };
  client: {
    healthCheck?: { getStatus(): HealthStatus };
  };
  tools: McpToolDefinition[];
}

/**
 * Minimal interface for an MCP registry needed by the capability projector.
 * Decouples from the McpRegistry class to break the circular dependency chain.
 */
export interface McpCapabilitySource {
  getAllServers(): IterableIterator<[string, McpServerInfoForCapability]>;
}

export interface McpToolCapability {
  name: string;
  description: string;
  inputSchema: McpToolDefinition['inputSchema'];
}

export interface McpServerCapability {
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
  tools: McpToolCapability[];
}

function mapConnectionStatus(
  status: McpConnectionStatus,
): McpServerCapability['status'] {
  const statusMap: Record<McpConnectionStatus, McpServerCapability['status']> = {
    [McpConnectionStatus.CONNECTED]: 'connected',
    [McpConnectionStatus.DISCONNECTED]: 'disconnected',
    [McpConnectionStatus.CONNECTING]: 'connecting',
    [McpConnectionStatus.ERROR]: 'error',
  };
  return statusMap[status];
}

function mapHealthStatus(
  status: HealthStatus | undefined,
  enabled: boolean,
): McpServerCapability['health']['status'] {
  if (!enabled) {
    return 'disabled';
  }

  switch (status) {
    case HealthStatus.HEALTHY:
      return 'healthy';
    case HealthStatus.DEGRADED:
      return 'degraded';
    case HealthStatus.UNHEALTHY:
      return 'unhealthy';
    case HealthStatus.CHECKING:
      return 'checking';
    default:
      return 'unknown';
  }
}

export function projectMcpCapabilities(registry: McpCapabilitySource): McpServerCapability[] {
  return Array.from(registry.getAllServers()).map(([name, serverInfo]) => ({
    name,
    status: mapConnectionStatus(serverInfo.status),
    connectedAt: serverInfo.connectedAt,
    error: serverInfo.lastError?.message,
    auth: {
      enabled: serverInfo.config.oauth?.enabled ?? false,
      provider: serverInfo.config.oauth?.provider,
    },
    health: {
      enabled: serverInfo.config.healthCheck?.enabled ?? false,
      status: mapHealthStatus(
        serverInfo.client.healthCheck?.getStatus(),
        serverInfo.config.healthCheck?.enabled ?? false,
      ),
    },
    tools: serverInfo.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
}
