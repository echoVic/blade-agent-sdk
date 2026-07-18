import { describe, expect, it } from 'vitest';
import { McpRegistry, type McpServerInfo } from '../local/McpRegistry.js';
import { McpConnectionStatus } from '../local/mcpTypes.js';

describe('McpRegistry (agent-sdk)', () => {
  it('can be instantiated', () => {
    const registry = new McpRegistry();
    expect(registry).toBeInstanceOf(McpRegistry);
  });

  it('provides initial statistics with expected shape', () => {
    const registry = new McpRegistry();
    const stats = registry.getStatistics();
    expect(stats).toHaveProperty('totalServers');
    expect(stats).toHaveProperty('connectedServers');
    expect(stats).toHaveProperty('errorServers');
    expect(stats).toHaveProperty('totalTools');
    expect(stats).toHaveProperty('isDiscovering');
    expect(stats.totalServers).toBe(0);
    expect(stats.connectedServers).toBe(0);
  });

  it('starts with no servers and can list them', () => {
    const registry = new McpRegistry();
    const servers = registry.listServers();
    expect(servers).toBeDefined();
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(0);
  });
});
