/**
 * MCP Health Types
 *
 * Health monitoring configuration and status enum.
 * Extracted from HealthMonitor.ts to reduce circular dependency chain.
 */

/**
 * 健康检查配置
 */
export interface HealthCheckConfig {
  /** 检查间隔（毫秒），默认 30 秒 */
  interval?: number;
  /** 超时时间（毫秒），默认 10 秒 */
  timeout?: number;
  /** 是否启用，默认 false */
  enabled?: boolean;
  /** 连续失败多少次后触发重连，默认 3 次 */
  failureThreshold?: number;
}

/**
 * 健康状态
 */
export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  CHECKING = 'checking',
}
