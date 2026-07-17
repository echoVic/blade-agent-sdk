import type { McpServerConfig } from '../types/common.js';
import type { McpConnectionStatus, McpToolDefinition } from './mcpTypes.js';
import type { SdkMcpServerHandle } from './mcp.js';
import type { HealthStatus } from './mcpHealth.js';

/**
 * Minimal interface for an MCP client reference.
 * Used by McpServerInfo to avoid depending on the full McpClient class.
 */
export interface McpClientLike {
  healthCheck?: { getStatus(): HealthStatus };
}

/**
 * MCP server registration information.
 * Moved from root McpRegistry.ts to break circular dependency chain.
 */
export interface McpServerInfo {
  config: McpServerConfig;
  client: McpClientLike;
  status: McpConnectionStatus;
  connectedAt?: Date;
  lastError?: Error;
  tools: McpToolDefinition[];
  inProcessHandle?: SdkMcpServerHandle;
}
