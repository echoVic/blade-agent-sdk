/**
 * MCP 客户端（SDK 版本 + 增强功能）
 * 使用官方 @modelcontextprotocol/sdk
 * 支持重试、自动重连、错误分类、OAuth 认证、健康监控
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EventEmitter } from 'node:events';
import type { JsonObject, JsonValue, McpServerConfig } from '../types/common.js';
import { toError } from '@blade-ai/agent/utils';
import { getPackageName, getVersion } from './packageInfo.js';
import { OAuthProvider } from './OAuthProvider.js';
import { OAuthTokenStorage } from './OAuthTokenStorage.js';
import { type HealthCheckConfig, HealthMonitor } from './HealthMonitor.js';
import type { SdkMcpServerHandle } from './SdkMcpServer.js';
import {
    McpConnectionStatus,
    type McpToolCallResponse,
    type McpToolDefinition,
} from './mcpTypes.js';

/**
 * 错误类型枚举
 */
export enum ErrorType {
  NETWORK_TEMPORARY = 'network_temporary', // 临时网络错误（可重试）
  NETWORK_PERMANENT = 'network_permanent', // 永久网络错误
  CONFIG_ERROR = 'config_error', // 配置错误
  AUTH_ERROR = 'auth_error', // 认证错误
  PROTOCOL_ERROR = 'protocol_error', // 协议错误
  UNKNOWN = 'unknown', // 未知错误
}

/**
 * 分类后的错误
 */
interface ClassifiedError {
  type: ErrorType;
  isRetryable: boolean;
  originalError: Error;
}

/**
 * 错误分类函数
 */
function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof Error)) {
    return {
      type: ErrorType.UNKNOWN,
      isRetryable: false,
      originalError: new Error(String(error)),
    };
  }

  const msg = error.message.toLowerCase();

  // 永久性配置错误（不应重试）
  const permanentErrors = [
    'command not found',
    'no such file',
    'permission denied',
    'invalid configuration',
    'malformed',
    'syntax error',
  ];

  if (permanentErrors.some((permanent) => msg.includes(permanent))) {
    return {
      type: ErrorType.CONFIG_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 认证错误（不应自动重试，需要用户介入）
  if (
    msg.includes('unauthorized') ||
    msg.includes('401') ||
    msg.includes('authentication failed')
  ) {
    return {
      type: ErrorType.AUTH_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 临时网络错误（可重试）
  const temporaryErrors = [
    'timeout',
    'connection refused',
    'network error',
    'temporary',
    'try again',
    'rate limit',
    'too many requests',
    'service unavailable',
    'socket hang up',
    'econnreset',
    'enotfound',
    'econnrefused',
    'etimedout',
    '503',
    '429',
  ];

  if (temporaryErrors.some((temporary) => msg.includes(temporary))) {
    return {
      type: ErrorType.NETWORK_TEMPORARY,
      isRetryable: true,
      originalError: error,
    };
  }

  // 默认视为临时错误（保守策略：允许重试）
  return {
    type: ErrorType.UNKNOWN,
    isRetryable: true,
    originalError: error,
  };
}

/**
 * 客户端选项
 */
export interface McpClientOptions {
  /** 是否禁止健康检查 */
  disableHealthCheck?: boolean;
  /** 自定义健康检查配置 */
  healthCheckConfig?: HealthCheckConfig;
  /** 是否开启 OAuth (默认: true) */
  enableOAuth?: boolean;
  /** OAuth Token 存储实例 */
  oauthTokenStorage?: OAuthTokenStorage;
}

/**
 * MCP客户端
 */
export class McpClient extends EventEmitter {
  private status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED;
  private sdkClient: Client | null = null;
  private tools = new Map<string, McpToolDefinition>();
  private serverInfo: { name: string; version: string } | null = null;

  // 重连相关
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isManualDisconnect = false;

  // OAuth 支持
  private oauthProvider: OAuthProvider | null = null;
  private serverName: string;

  // 健康监控
  private healthMonitor: HealthMonitor | null = null;

  // In-process MCP server handle (if type is 'in-process')
  private inProcessHandle: SdkMcpServerHandle | undefined;

  // 服务器配置
  readonly config: McpServerConfig;

  /**
   * 创建 MCP 客户端
   */
  constructor(
    serverName: string,
    config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    super();
    this.serverName = serverName;
    this.config = config;

    // 构建 OAuth Provider
    if (options.enableOAuth !== false) {
      const tokenStorage = options.oauthTokenStorage || new OAuthTokenStorage(serverName);
      this.oauthProvider = new OAuthProvider(tokenStorage);
    }

    // HealthMonitor
    if (!options.disableHealthCheck) {
      this.healthMonitor = new HealthMonitor(this, options.healthCheckConfig);
    }

    // Matches McpClientLike interface implicitly
  }

  /** Connection status (public readonly proxy) */
  get connectionStatus(): McpConnectionStatus {
    return this.status;
  }

  /** Available tools (public readonly proxy) */
  get availableTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Server info (public readonly proxy) */
  get server(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  // MCP Client API

  /**
   * 连接到底层 MCP 服务器
   */
  async connect(): Promise<void> {
    if (this.status === McpConnectionStatus.CONNECTED) {
      console.warn('[McpClient] 已经处于连接状态');
      return;
    }

    this.setStatus(McpConnectionStatus.CONNECTING);

    try {
      // 构建传输层
      let transport: Transport;
      try {
        transport = await this.buildTransport();
      } catch (error) {
        this.setStatus(McpConnectionStatus.ERROR);
        throw new Error(
          `[McpClient] 构建传输层失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 初始化客户端
      this.sdkClient = new Client(
        { name: getPackageName(), version: getVersion() },
        { capabilities: {} },
      );

      try {
        await this.sdkClient.connect(transport);
      } catch (error) {
        this.sdkClient = null;
        this.setStatus(McpConnectionStatus.ERROR);

        const classified = classifyError(error);
        if (classified.isRetryable && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
          console.warn('[McpClient] 连接失败，将尝试重连:', classified.type);
          this.scheduleReconnect();
          return;
        }

        throw error;
      }

      // 获取服务器信息
      try {
        const capabilities = this.sdkClient.getServerCapabilities();
        this.serverInfo = {
          name: this.serverName,
          version: (capabilities as Record<string, unknown>)?.['serverVersion'] as string || 'unknown',
        };
      } catch {
        this.serverInfo = { name: this.serverName, version: 'unknown' };
      }

      // 加载工具列表
      await this.loadTools();

      this.reconnectAttempts = 0;
      this.setStatus(McpConnectionStatus.CONNECTED);

      // 启动健康监控
      this.healthMonitor?.start();
    } catch (error) {
      this.setStatus(McpConnectionStatus.ERROR);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;
    this.healthMonitor?.stop();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.sdkClient) {
        await this.sdkClient.close();
        this.sdkClient = null;
      }
    } catch (error) {
      console.error('[McpClient] 断开连接失败:', error);
    }

    this.tools.clear();
    this.status = McpConnectionStatus.DISCONNECTED;
    this.serverInfo = null;
    this.reconnectAttempts = 0;
  }

  /**
   * 调用工具
   */
  async callTool(name: string, params: Record<string, unknown>): Promise<McpToolCallResponse> {
    if (!this.sdkClient) {
      throw new Error('客户端未连接');
    }

    try {
      const result = await this.sdkClient.callTool(
        { name, arguments: params },
        undefined,
        { timeout: 60000 }, // 60s timeout
      );

      return result as McpToolCallResponse;
    } catch (error) {
      const classified = classifyError(error);
      if (classified.isRetryable) {
        console.warn('[McpClient] 工具调用失败,尝试重试:', name, error);
        try {
          const result = await this.sdkClient.callTool(
            { name, arguments: params },
            undefined,
            { timeout: 60000 },
          );
          return result as McpToolCallResponse;
        } catch (retryError) {
          throw retryError;
        }
      }
      throw error;
    }
  }

  /**
   * 连接状态变化
   */
  onStatusChange(handler: (status: McpConnectionStatus, oldStatus: McpConnectionStatus) => void): void {
    this.on('statusChanged', handler);
  }

  // ========================================
  // 内部方法
  // ========================================

  /**
   * 调度重连
   */
  private scheduleReconnect(): void {
    if (this.isManualDisconnect) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // 指数退避,最多30秒

    console.log(
      `[McpClient] 计划在 ${delay}ms 后重连 (第 ${this.reconnectAttempts + 1} 次)`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      console.log(`[McpClient] 执行第 ${this.reconnectAttempts} 次重连...`);

      try {
        await this.connect();
      } catch (error) {
        console.error(`[McpClient] 重连失败:`, error);
        if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
          this.scheduleReconnect();
        } else {
          console.error(
            `[McpClient] 达到最大重连次数 (${this.MAX_RECONNECT_ATTEMPTS})，停止重连`,
          );
        }
      }
    }, delay);
  }

  /**
   * 构建传输层
   */
  private async buildTransport(): Promise<Transport> {
    const { type, command, args, env, url, headers } = this.config;

    // Build request headers for HTTP-based transports
    const finalHeaders: Record<string, string> = { ...(headers || {}) };

    // OAuth: 如果配置中有 OAuth metadata / URI
    const oauth = this.config.oauth;
    if (oauth && this.oauthProvider) {
      try {
        const token = await this.oauthProvider.getValidToken(
          this.serverName,
          oauth,
        );

        if (token === null) {
          // 没有有效令牌,需要认证
          console.log(
            `[McpClient] 服务器 "${this.serverName}" 需要 OAuth 认证`,
          );
          const newToken = await this.oauthProvider.authenticate(
            this.serverName,
            oauth,
          );
          finalHeaders.Authorization = `Bearer ${newToken.accessToken}`;
        } else {
          // 有有效令牌
          finalHeaders.Authorization = `Bearer ${token}`;
        }
      } catch (error) {
        console.error('[McpClient] OAuth 认证失败:', error);
        throw new Error(
          `OAuth 认证失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // In-process transport (from SdkMcpServer)
    // Each call creates a new transport pair, enabling reconnection
    if (this.inProcessHandle) {
      return this.inProcessHandle.createClientTransport();
    }

    if (type === 'stdio') {
      if (!command) {
        throw new Error('stdio 传输需要 command 参数');
      }
      // 过滤掉 undefined 值
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          processEnv[key] = value;
        }
      }
      return new StdioClientTransport({
        command,
        args: args || [],
        env: { ...processEnv, ...env },
        stderr: 'ignore', // 忽略子进程的 stderr 输出
      });
    } else if (type === 'sse') {
      if (!url) {
        throw new Error('sse 传输需要 url 参数');
      }
      return new SSEClientTransport(new URL(url), {
        requestInit: {
          headers: finalHeaders,
        },
      });
    } else if (type === 'http') {
      if (!url) {
        throw new Error('http 传输需要 url 参数');
      }
      // HTTP 传输需要动态导入
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: finalHeaders,
        },
      });
    }

    throw new Error(`不支持的传输类型: ${type}`);
  }

  /**
   * 加载工具列表
   */
  private async loadTools(): Promise<void> {
    if (!this.sdkClient) {
      return;
    }

    try {
      const response = await this.sdkClient.listTools();

      this.tools.clear();
      if (response.tools) {
        for (const tool of response.tools) {
          this.tools.set(tool.name, tool as McpToolDefinition);
        }
      }

      this.emit('toolsUpdated', this.availableTools);
    } catch (error) {
      console.error('[McpClient] 加载工具失败:', error);
      throw error;
    }
  }

  /**
   * 设置连接状态
   */
  private setStatus(status: McpConnectionStatus): void {
    const oldStatus = this.status;
    this.status = status;
    this.emit('statusChanged', status, oldStatus);
  }

  // ========================================
  // 兼容性方法（保持与 Registry 的接口一致）
  // ========================================

  async initialize(): Promise<void> {
    return this.connect();
  }

  async destroy(): Promise<void> {
    return this.disconnect();
  }

  async connectToServer(_serverId?: string): Promise<void> {
    return this.connect();
  }

  async disconnectFromServer(_serverId?: string): Promise<void> {
    return this.disconnect();
  }

  async listResources(_serverId?: string): Promise<JsonValue[]> {
    if (!this.sdkClient) {
      return [];
    }
    try {
      const response = await this.sdkClient.listResources();
      return (response.resources || []) as unknown as JsonValue[];
    } catch {
      return [];
    }
  }

  async listTools(_serverId?: string): Promise<McpToolDefinition[]> {
    return this.availableTools;
  }

  async readResource(uri: string, _serverId?: string): Promise<JsonValue> {
    if (!this.sdkClient) {
      throw new Error('客户端未连接');
    }
    const response = await this.sdkClient.readResource({ uri });
    return (response.contents?.[0] || { uri, text: '' }) as unknown as JsonValue;
  }
}
