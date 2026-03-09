import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { HealthMonitor, HealthStatus, type HealthCheckConfig } from '../HealthMonitor.js';
import type { McpClient } from '../McpClient.js';
import { McpConnectionStatus } from '../types.js';

const createMockClient = (status: McpConnectionStatus = McpConnectionStatus.CONNECTED) => ({
  connectionStatus: status,
  callTool: mock(() => Promise.resolve({ content: [] })),
  on: mock(() => {}),
  emit: mock(() => {}),
});

function createMonitor(client: ReturnType<typeof createMockClient>, config: HealthCheckConfig) {
  return new HealthMonitor(client as unknown as McpClient, config);
}

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  afterEach(() => {
    if (monitor) {
      monitor.stop();
    }
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const config: HealthCheckConfig = { enabled: true };
      monitor = createMonitor(mockClient, config);

      expect(monitor).toBeDefined();
    });

    it('should create with custom config', () => {
      const config: HealthCheckConfig = {
        enabled: true,
        interval: 5000,
        timeout: 2000,
        failureThreshold: 5,
      };
      monitor = createMonitor(mockClient, config);

      expect(monitor).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start health monitoring when enabled', () => {
      const config: HealthCheckConfig = { enabled: true, interval: 60000 };
      monitor = createMonitor(mockClient, config);

      monitor.start();
      monitor.stop();

      expect(monitor.getStatus()).toBe(HealthStatus.HEALTHY);
    });

    it('should not start if not enabled', () => {
      const config: HealthCheckConfig = { enabled: false, interval: 60000 };
      monitor = createMonitor(mockClient, config);

      monitor.start();

      expect(monitor.getStatus()).toBe(HealthStatus.HEALTHY);
    });
  });

  describe('stop', () => {
    it('should stop health monitoring', () => {
      const config: HealthCheckConfig = { enabled: true, interval: 60000 };
      monitor = createMonitor(mockClient, config);

      monitor.start();
      monitor.stop();

      expect(monitor.getStatus()).toBe(HealthStatus.HEALTHY);
    });

    it('should not throw if not running', () => {
      const config: HealthCheckConfig = { enabled: true };
      monitor = createMonitor(mockClient, config);

      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('getLastResult', () => {
    it('should return result with initial status', () => {
      const config: HealthCheckConfig = { enabled: true };
      monitor = createMonitor(mockClient, config);

      const result = monitor.getLastResult();
      expect(result.status).toBe(HealthStatus.HEALTHY);
      expect(result.consecutiveFailures).toBe(0);
    });
  });

  describe('HealthStatus enum', () => {
    it('should have HEALTHY status', () => {
      expect(HealthStatus.HEALTHY).toBe(HealthStatus.HEALTHY);
      expect(String(HealthStatus.HEALTHY)).toBe('healthy');
    });

    it('should have DEGRADED status', () => {
      expect(HealthStatus.DEGRADED).toBe(HealthStatus.DEGRADED);
      expect(String(HealthStatus.DEGRADED)).toBe('degraded');
    });

    it('should have UNHEALTHY status', () => {
      expect(HealthStatus.UNHEALTHY).toBe(HealthStatus.UNHEALTHY);
      expect(String(HealthStatus.UNHEALTHY)).toBe('unhealthy');
    });

    it('should have CHECKING status', () => {
      expect(HealthStatus.CHECKING).toBe(HealthStatus.CHECKING);
      expect(String(HealthStatus.CHECKING)).toBe('checking');
    });
  });
});
