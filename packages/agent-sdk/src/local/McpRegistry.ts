/**
 * MCP 注册表
 * 管理MCP服务器连接和工具发现
 *
 * per-session 实例，每个 Session/Agent 创建自己的 McpRegistry
 */

import { EventEmitter } from 'node:events';
import type { McpServerConfig } from '../types/common.js';
import type { Tool } from '../tools/types/index.js';
import { toError } from '@blade-ai/agent/utils';
import { createMcpTool } from './createMcpTool.js';
import { McpClient } from './McpClient.js';
import type { SdkMcpServerHandle } from './SdkMcpServer.js';
import { McpConnectionStatus, type McpToolDefinition } from './mcpTypes.js';

/**
 * MCP服务器信息
 */
export interface McpServerInfo {
  config: McpServerConfig;
  client: McpClient;
  status: McpConnectionStatus;
  connectedAt?: Date;
  lastError?: Error;
  tools: McpToolDefinition[];
  inProcessHandle?: SdkMcpServerHandle;
}

/**
 * MCP注册表
 */
export class McpRegistry extends EventEmitter {
  private servers: Map<string, McpServerInfo> = new Map();
  private isDiscovering = false;
  private readonly storageRoot?: string;

  constructor(storageRoot?: string) {
    super();
    this.storageRoot = storageRoot;
  }

  /**
   * 注册MCP服务器
   */
  async registerServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`MCP服务器 "${name}" 已经注册`);
    }

    const client = new McpClient(name, config, { healthCheckConfig: config.healthCheck });
    const serverInfo: McpServerInfo = {
      config,
      client,
      status: McpConnectionStatus.DISCONNECTED,
      tools: [],
    };

    // 设置客户端事件处理器
    this.setupClientEventHandlers(client, serverInfo, name);

    this.servers.set(name, serverInfo);
    this.emit('serverRegistered', name, serverInfo);

    try {
      await this.connectServer(name);
    } catch (error) {
      console.warn(`MCP服务器 "${name}" 连接失败:`, error);
    }
  }

  /**
   * 注册 In-Process MCP 服务器（通过 SdkMcpServerHandle）
   *
   * 行为：
   * - 如果同名服务器不存在 → 正常注册并连接
   * - 如果同名服务器存在且是同一个 handle → 确保已连接（如果断开则重连）
   * - 如果同名服务器存在但是不同的 handle → 抛出错误
   */
  async registerInProcessServer(name: string, handle: SdkMcpServerHandle): Promise<void> {
    const existing = this.servers.get(name);
    if (existing) {
      if (existing.inProcessHandle === handle) {
        if (existing.status === McpConnectionStatus.CONNECTING) {
          await this.waitForServerConnected(name);
        } else if (existing.status !== McpConnectionStatus.CONNECTED) {
          await this.connectServer(name);
        }
        return;
      }
      throw new Error(
        `MCP server "${name}" is already registered with a different handle. ` +
        `In-process servers cannot be replaced while other sessions may be using them.`
      );
    }

    const config: McpServerConfig = {
      command: '',
    };

    const client = new McpClient(name, config, { inProcessHandle: handle });
    const serverInfo: McpServerInfo = {
      config,
      client,
      status: McpConnectionStatus.DISCONNECTED,
      tools: [],
      inProcessHandle: handle,
    };

    this.setupClientEventHandlers(client, serverInfo, name);
    this.servers.set(name, serverInfo);
    this.emit('serverRegistered', name, serverInfo);

    try {
      await this.connectServer(name);
    } catch (error) {
      console.warn(`In-process MCP服务器 "${name}" 连接失败:`, error);
    }
  }

  /**
   * 注销MCP服务器
   */
  async unregisterServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    try {
      await serverInfo.client.disconnect();
    } catch (error) {
      console.warn(`断开MCP服务器 "${name}" 时出错:`, error);
    }

    this.servers.delete(name);
    this.emit('serverUnregistered', name);
  }

  /**
   * 连接到指定服务器
   */
  async connectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    if (serverInfo.status === McpConnectionStatus.CONNECTED) {
      return;
    }

    serverInfo.status = McpConnectionStatus.CONNECTING;
    this.emit('serverConnecting', name);

    try {
      await serverInfo.client.connect();
    } catch (error) {
      serverInfo.status = McpConnectionStatus.ERROR;
      serverInfo.lastError = toError(error);
      this.emit('serverError', name, toError(error));
      throw error;
    }
  }

  /**
   * 等待服务器连接就绪（最多30秒）
   */
  private async waitForServerConnected(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    if (serverInfo.status === McpConnectionStatus.CONNECTED) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`等待MCP服务器 "${name}" 连接超时`));
      }, 30000);

      const statusHandler = (serverName: string, newStatus: McpConnectionStatus) => {
        if (serverName === name && newStatus === McpConnectionStatus.CONNECTED) {
          cleanup();
          resolve();
        } else if (serverName === name && newStatus === McpConnectionStatus.ERROR) {
          cleanup();
          reject(new Error(`MCP服务器 "${name}" 连接失败`));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('serverStatusChanged', statusHandler);
      };

      this.on('serverStatusChanged', statusHandler);
    });
  }

  /**
   * 断开指定服务器连接
   */
  async disconnectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    try {
      await serverInfo.client.disconnect();
    } catch (error) {
      console.warn(`断开MCP服务器 "${name}" 连接时出错:`, error);
    }
  }

  /**
   * 断开所有服务器连接
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const [name, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED
        || serverInfo.status === McpConnectionStatus.CONNECTING) {
        disconnectPromises.push(
          serverInfo.client.disconnect().catch((error) => {
            console.warn(`断开 MCP 服务器 "${name}" 时出错:`, error);
          })
        );
      }
    }

    await Promise.allSettled(disconnectPromises);
    this.servers.clear();
  }

  /**
   * 获取服务器信息
   */
  getServer(name: string): McpServerInfo | undefined {
    return this.servers.get(name);
  }

  /**
   * 列出所有已注册的服务器
   */
  listServers(): McpServerInfo[] {
    return Array.from(this.servers.values());
  }

  /**
   * 获取所有已连接服务器的工具列表
   */
  getConnectedTools(): Tool[] {
    const allTools: Tool[] = [];

    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        for (const toolDef of serverInfo.tools) {
          try {
            const tool = createMcpTool(
              serverInfo.client,
              serverName,
              toolDef,
            );
            allTools.push(tool);
          } catch (error) {
            console.warn(
              `为MCP服务器 "${serverName}" 创建工具 "${toolDef.name}" 失败:`,
              error
            );
          }
        }
      }
    }

    return allTools;
  }

  /**
   * 获取指定服务器的工具列表
   */
  getServerTools(serverName: string): Tool[] {
    const serverInfo = this.servers.get(serverName);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return [];
    }

    return serverInfo.tools
      .map((toolDef) => {
        try {
          return createMcpTool(
            serverInfo.client,
            serverName,
            toolDef,
          );
        } catch (error) {
          console.warn(
            `为MCP服务器 "${serverName}" 创建工具 "${toolDef.name}" 失败:`,
            error
          );
          return null;
        }
      })
      .filter((tool): tool is Tool => tool !== null);
  }

  /**
   * 获取所有服务器状态
   */
  getServerStatuses(): Map<string, McpConnectionStatus> {
    const statuses = new Map<string, McpConnectionStatus>();
    for (const [name, info] of this.servers) {
      statuses.set(name, info.status);
    }
    return statuses;
  }

  /**
   * 检查服务器是否已连接
   */
  isServerConnected(name: string): boolean {
    const serverInfo = this.servers.get(name);
    return serverInfo?.status === McpConnectionStatus.CONNECTED;
  }

  /**
   * 刷新指定服务器工具列表
   */
  async refreshServerTools(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return;
    }

    try {
      // 重新获取工具列表
      const newTools = serverInfo.client.availableTools;
      const oldToolsCount = serverInfo.tools.length;
      serverInfo.tools = newTools;

      this.emit('toolsUpdated', name, newTools, oldToolsCount);
    } catch (error) {
      console.warn(`刷新服务器 "${name}" 工具列表失败:`, error);
    }
  }

  /**
   * 设置客户端事件处理器
   */
  private setupClientEventHandlers(
    client: McpClient,
    serverInfo: McpServerInfo,
    name: string
  ): void {
    client.on('connected', (server) => {
      serverInfo.status = McpConnectionStatus.CONNECTED;
      serverInfo.connectedAt = new Date();
      serverInfo.tools = client.availableTools;
      this.emit('serverConnected', name, server);
    });

    client.on('disconnected', () => {
      serverInfo.status = McpConnectionStatus.DISCONNECTED;
      serverInfo.connectedAt = undefined;
      serverInfo.tools = [];
      this.emit('serverDisconnected', name);
    });

    client.on('error', (error) => {
      serverInfo.status = McpConnectionStatus.ERROR;
      serverInfo.lastError = error;
      this.emit('serverError', name, error);
    });

    client.on('toolsUpdated', (tools) => {
      const oldToolsCount = serverInfo.tools.length;
      serverInfo.tools = tools;
      this.emit('toolsUpdated', name, tools, oldToolsCount);
    });

    client.on('statusChanged', (newStatus, oldStatus) => {
      serverInfo.status = newStatus;
      this.emit('serverStatusChanged', name, newStatus, oldStatus);
    });
  }

  /**
   * 自动发现MCP服务器 (基础实现，可扩展)
   */
  async discoverServers(): Promise<McpServerInfo[]> {
    if (this.isDiscovering) {
      return Array.from(this.servers.values());
    }

    this.isDiscovering = true;
    this.emit('discoveryStarted');

    try {
      // 这里可以实现自动发现逻辑
      // 例如扫描常见的MCP服务器安装位置
      // 或者读取配置文件中的服务器列表

      // 目前返回已注册的服务器
      return Array.from(this.servers.values());
    } finally {
      this.isDiscovering = false;
      this.emit('discoveryCompleted');
    }
  }

  /**
   * 批量注册服务器
   */
  async registerServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const registrationPromises = Object.entries(servers).map(([name, config]) =>
      this.registerServer(name, config).catch((error) => {
        console.warn(`注册MCP服务器 "${name}" 失败:`, error);
        return error;
      })
    );

    await Promise.allSettled(registrationPromises);
  }

  /**
   * 获取统计信息
   */
  getStatistics() {
    let connectedCount = 0;
    let totalTools = 0;
    let errorCount = 0;

    for (const serverInfo of this.servers.values()) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        connectedCount++;
        totalTools += serverInfo.tools.length;
      } else if (serverInfo.status === McpConnectionStatus.ERROR) {
        errorCount++;
      }
    }

    return {
      totalServers: this.servers.size,
      connectedServers: connectedCount,
      errorServers: errorCount,
      totalTools,
      isDiscovering: this.isDiscovering,
    };
  }

  getToolsByServer(serverName: string): Tool[] {
    const result: Tool[] = [];
    const serverInfo = this.servers.get(serverName);
    if (!serverInfo) {
      return result;
    }
    for (const toolDef of serverInfo.tools) {
      try {
        const tool = createMcpTool(
          serverInfo.client,
          serverName,
          toolDef,
        );
        result.push(tool);
      } catch (_error) {
        // skip invalid tool
      }
    }
    return result;
  }
}
