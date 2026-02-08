import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { McpRegistry } from '../../mcp/McpRegistry.js';

const mockConnect = mock(() => Promise.resolve());
const mockDisconnect = mock(() => Promise.resolve());
const mockOn = mock(() => {});

mock.module('../../mcp/McpClient.js', () => ({
  McpClient: class MockMcpClient {
    availableTools = [
      { name: 'test_tool', description: 'A test tool' },
    ];
    connect = mockConnect;
    disconnect = mockDisconnect;
    on = mockOn;
  },
}));

describe('Session MCP Methods', () => {
  let registry: McpRegistry;

  beforeEach(() => {
    (McpRegistry as unknown as { instance: McpRegistry | null }).instance = null;
    registry = McpRegistry.getInstance();
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockOn.mockClear();
  });

  afterEach(async () => {
    await registry.disconnectAll();
  });

  describe('mcpServerStatus', () => {
    it('should return empty array when no servers registered', () => {
      const servers = registry.getAllServers();
      expect(servers.size).toBe(0);
    });

    it('should return server status after registration', async () => {
      await registry.registerServer('test-server', { command: 'test' });

      const servers = registry.getAllServers();
      expect(servers.size).toBe(1);

      const serverInfo = servers.get('test-server');
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.status).toBeDefined();
    });
  });

  describe('mcpConnect', () => {
    it('should connect to registered server', async () => {
      await registry.registerServer('test-server', { command: 'test' });
      await registry.connectServer('test-server');

      expect(mockConnect).toHaveBeenCalled();
    });

    it('should throw error for non-existent server', async () => {
      await expect(registry.connectServer('non-existent')).rejects.toThrow();
    });
  });

  describe('mcpDisconnect', () => {
    it('should disconnect from registered server', async () => {
      await registry.registerServer('test-server', { command: 'test' });
      await registry.disconnectServer('test-server');

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should not throw for non-existent server', async () => {
      await expect(registry.disconnectServer('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('mcpReconnect', () => {
    it('should reconnect to registered server', async () => {
      await registry.registerServer('test-server', { command: 'test' });
      await registry.reconnectServer('test-server');

      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('mcpListTools', () => {
    it('should return tools from connected servers', async () => {
      await registry.registerServer('test-server', { command: 'test' });

      const tools = registry.getToolsByServer('test-server');
      expect(tools).toBeInstanceOf(Array);
    });

    it('should return empty array for non-existent server', () => {
      const tools = registry.getToolsByServer('non-existent');
      expect(tools).toEqual([]);
    });
  });
});
