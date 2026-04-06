import { HealthStatus } from './HealthMonitor.js';
import type { McpRegistry } from './McpRegistry.js';
import { McpConnectionStatus, type McpToolDefinition } from './types.js';

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

export function projectMcpCapabilities(registry: McpRegistry): McpServerCapability[] {
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
