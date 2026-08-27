import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../McpRegistry.js';
import { McpConnectionStatus } from '../types.js';

const mockConnect = vi.fn(() => Promise.resolve());
const mockDisconnect = vi.fn(() => Promise.resolve());
const mockOn = vi.fn((_event: string, _handler: (...args: unknown[]) => void) => {});

vi.mock('../McpClient.js', () => ({
  McpClient: class MockMcpClient {
    availableTools = [];
    connect = mockConnect;
    disconnect = mockDisconnect;
    on = mockOn;
  },
}));

describe('McpRegistry', () => {
  let registry: McpRegistry;

  beforeEach(() => {
    registry = new McpRegistry();
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockOn.mockClear();
  });

  afterEach(async () => {
    await registry.disconnectAll();
  });

  describe('constructor', () => {
    it('should create independent instances', () => {
      const instance1 = new McpRegistry();
      const instance2 = new McpRegistry();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('registerServer', () => {
    it('should register a new server', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      const serverInfo = registry.getServerStatus('test');
      expect(serverInfo).not.toBeNull();
      expect(serverInfo?.config).toEqual(config);
    });

    it('should throw error when registering duplicate server', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      await expect(registry.registerServer('test', config)).rejects.toThrow(
        'MCP服务器 "test" 已经注册'
      );
    });

    it('should emit serverRegistered event', async () => {
      const config = { command: 'test-server' };
      const eventHandler = vi.fn(() => {});
      registry.on('serverRegistered', eventHandler);

      await registry.registerServer('test', config);

      expect(eventHandler).toHaveBeenCalledWith('test', expect.any(Object));
    });
  });

  describe('unregisterServer', () => {
    it('should unregister an existing server', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      await registry.unregisterServer('test');

      const serverInfo = registry.getServerStatus('test');
      expect(serverInfo).toBeNull();
    });

    it('should emit serverUnregistered event', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      const eventHandler = vi.fn(() => {});
      registry.on('serverUnregistered', eventHandler);

      await registry.unregisterServer('test');

      expect(eventHandler).toHaveBeenCalledWith('test');
    });

    it('should not throw when unregistering non-existent server', async () => {
      await expect(registry.unregisterServer('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('connectServer', () => {
    it('should throw error for unregistered server', async () => {
      await expect(registry.connectServer('non-existent')).rejects.toThrow(
        'MCP服务器 "non-existent" 未注册'
      );
    });
  });

  describe('disconnectServer', () => {
    it('should disconnect an existing server', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      await registry.disconnectServer('test');

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should not throw when disconnecting non-existent server', async () => {
      await expect(registry.disconnectServer('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('getAllServers', () => {
    it('should return all registered servers', async () => {
      await registry.registerServer('server1', { command: 'cmd1' });
      await registry.registerServer('server2', { command: 'cmd2' });

      const servers = registry.getAllServers();
      expect(servers.size).toBe(2);
      expect(servers.has('server1')).toBe(true);
      expect(servers.has('server2')).toBe(true);
    });

    it('should return empty map when no servers registered', () => {
      const servers = registry.getAllServers();
      expect(servers.size).toBe(0);
    });
  });

  describe('getServerStatus', () => {
    it('should return server info for registered server', async () => {
      const config = { command: 'test-server' };
      await registry.registerServer('test', config);

      const serverInfo = registry.getServerStatus('test');
      expect(serverInfo).not.toBeNull();
      expect(serverInfo?.config).toEqual(config);
    });

    it('should return null for non-existent server', () => {
      const serverInfo = registry.getServerStatus('non-existent');
      expect(serverInfo).toBeNull();
    });
  });

  describe('getStatistics', () => {
    it('should return correct statistics', async () => {
      await registry.registerServer('server1', { command: 'cmd1' });
      await registry.registerServer('server2', { command: 'cmd2' });

      const stats = registry.getStatistics();
      expect(stats.totalServers).toBe(2);
      expect(stats.isDiscovering).toBe(false);
    });

    it('should return zero stats when no servers', () => {
      const stats = registry.getStatistics();
      expect(stats.totalServers).toBe(0);
      expect(stats.connectedServers).toBe(0);
      expect(stats.errorServers).toBe(0);
      expect(stats.totalTools).toBe(0);
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all servers', async () => {
      await registry.registerServer('server1', { command: 'cmd1' });
      await registry.registerServer('server2', { command: 'cmd2' });

      await registry.disconnectAll();

      const servers = registry.getAllServers();
      expect(servers.size).toBe(0);
    });

    it('should stop clients that are not currently connected', async () => {
      await registry.registerServer('server1', { command: 'cmd1' });
      const server = registry.getServerStatus('server1');
      if (!server) throw new Error('Expected registered MCP server');
      server.status = McpConnectionStatus.ERROR;
      mockDisconnect.mockClear();

      await registry.disconnectAll();

      expect(mockDisconnect).toHaveBeenCalledOnce();
    });
  });

  describe('registerServers', () => {
    it('should register multiple servers', async () => {
      const servers = {
        server1: { command: 'cmd1' },
        server2: { command: 'cmd2' },
      };

      await registry.registerServers(servers);

      expect(registry.getServerStatus('server1')).not.toBeNull();
      expect(registry.getServerStatus('server2')).not.toBeNull();
    });
  });

  describe('getToolsByServer', () => {
    it('should return empty array for non-existent server', () => {
      const tools = registry.getToolsByServer('non-existent');
      expect(tools).toEqual([]);
    });
  });

  describe('event-driven state sync', () => {
    it('should clear lastError when the client reconnects after an error', async () => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      mockOn.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
        }
      );

      await registry.registerServer('test', { command: 'test-server' });

      // 模拟意外断开：客户端发出 error 事件
      handlers.error?.(new Error('MCP服务器连接意外关闭'));
      const afterError = registry.getServerStatus('test');
      expect(afterError?.lastError).toBeInstanceOf(Error);
      expect(afterError?.status).toBe('error');

      // 模拟自动重连成功：客户端发出 connected 事件
      handlers.connected?.({ name: 'test', version: '1.0.0' });
      const afterReconnect = registry.getServerStatus('test');
      expect(afterReconnect?.status).toBe('connected');
      expect(afterReconnect?.lastError).toBeUndefined();
    });
  });
});
