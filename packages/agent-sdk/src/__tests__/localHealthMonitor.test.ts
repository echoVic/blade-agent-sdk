import { describe, expect, it } from 'vitest';
import { HealthMonitor } from '../local/HealthMonitor.js';
import type { McpClientLike, McpToolCallResponse } from '../local/mcpTypes.js';
import { McpConnectionStatus } from '../local/mcpTypes.js';
import { HealthStatus } from '../local/mcpHealth.js';

// Minimal stub implementing McpClientLike
class MockMcpClient implements McpClientLike {
  connectionStatus: McpConnectionStatus = McpConnectionStatus.CONNECTED;
  availableTools: ReadonlyArray<{ name: string; description: string }> = [];
  server: { name: string; version: string } | null = { name: 'test', version: '1.0.0' };

  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  callTool(_name: string, _params: Record<string, unknown>): Promise<McpToolCallResponse> {
    return Promise.resolve({ content: [], isError: false });
  }
}

describe('HealthMonitor (agent-sdk)', () => {
  it('can be instantiated with a mock client', () => {
    const client = new MockMcpClient();
    const monitor = new HealthMonitor(client);
    expect(monitor).toBeInstanceOf(HealthMonitor);
  });

  it('reports initial health status as HEALTHY', () => {
    const client = new MockMcpClient();
    const monitor = new HealthMonitor(client);
    expect(monitor.getStatus()).toBe(HealthStatus.HEALTHY);
  });

  it('provides statistics with expected shape', () => {
    const client = new MockMcpClient();
    const monitor = new HealthMonitor(client);
    const stats = monitor.getStatistics();
    expect(stats).toHaveProperty('status');
    expect(stats).toHaveProperty('consecutiveFailures');
    expect(stats).toHaveProperty('lastCheckTime');
    expect(stats).toHaveProperty('isChecking');
    expect(stats).toHaveProperty('config');
  });
});
