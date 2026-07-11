import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolResult,
  Tool as McpToolDefinition,
} from '@modelcontextprotocol/sdk/types.js';
import { toolFromDefinition } from '../tools/index.js';
import type { Tool, ToolResult } from '../tools/types/index.js';
import { ToolErrorType } from '../tools/types/index.js';
import { ToolKind } from '../tools/types/ToolKind.js';
import type { McpServerConfig } from '../types/common.js';
import type { PackageLocalRuntimeMcpRegistryPort } from './runtimePorts.js';
import type { PackageLocalRuntimeMcpServerCapability } from './runtimeMcpCapabilities.js';
import type { SdkMcpServerHandle } from './types.js';

type ConnectionStatus = PackageLocalRuntimeMcpServerCapability['status'];

interface DefaultMcpServerConnection {
  config: McpServerConfig | SdkMcpServerHandle;
  client?: Client;
  connectPromise?: Promise<void>;
  status: ConnectionStatus;
  connectedAt?: Date;
  error?: string;
  tools: McpToolDefinition[];
}

export function createDefaultMcpRuntimeRegistry(): PackageLocalRuntimeMcpRegistryPort {
  const connections = new Map<string, DefaultMcpServerConnection>();

  async function connect(serverName: string): Promise<void> {
    const connection = connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not registered`);
    }
    if (connection.status === 'connected') return;
    if (connection.connectPromise) return connection.connectPromise;

    const connectPromise = establishConnection(connection);
    connection.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (connection.connectPromise === connectPromise) {
        connection.connectPromise = undefined;
      }
    }
  }

  async function establishConnection(connection: DefaultMcpServerConnection): Promise<void> {
    connection.status = 'connecting';
    connection.error = undefined;
    const staleClient = connection.client;
    connection.client = undefined;
    await staleClient?.close().catch(() => {});
    const client = new Client(
      { name: '@blade-ai/agent-sdk', version: '1.0.0' },
      { capabilities: {} },
    );
    client.onclose = () => {
      if (connection.client !== client) return;
      connection.client = undefined;
      connection.status = 'disconnected';
      connection.connectedAt = undefined;
      connection.tools = [];
    };
    client.onerror = (error) => {
      if (connection.client !== client) return;
      connection.status = 'error';
      connection.error = error.message;
      connection.connectedAt = undefined;
      connection.tools = [];
    };
    connection.client = client;
    try {
      await client.connect(await createTransport(connection.config));
      connection.tools = (await client.listTools()).tools;
      connection.status = 'connected';
      connection.connectedAt = new Date();
    } catch (error) {
      await client.close().catch(() => {});
      if (connection.client === client) {
        connection.client = undefined;
      }
      connection.status = 'error';
      connection.error = error instanceof Error ? error.message : String(error);
      connection.connectedAt = undefined;
      connection.tools = [];
      throw error;
    }
  }

  async function disconnect(serverName: string): Promise<void> {
    const connection = connections.get(serverName);
    if (!connection) return;
    await connection.connectPromise?.catch(() => {});
    await connection.client?.close();
    connection.client = undefined;
    connection.status = 'disconnected';
    connection.connectedAt = undefined;
    connection.tools = [];
  }

  async function register(
    serverName: string,
    config: McpServerConfig | SdkMcpServerHandle,
  ): Promise<void> {
    const existing = connections.get(serverName);
    if (existing) {
      if (existing.config !== config) {
        throw new Error(`MCP server "${serverName}" is already registered`);
      }
      await connect(serverName);
      return;
    }

    connections.set(serverName, {
      config,
      status: 'disconnected',
      tools: [],
    });
    await connect(serverName);
  }

  return {
    async disconnectAll() {
      await Promise.all([...connections.keys()].map(disconnect));
    },
    async getCapabilities() {
      return [...connections.entries()].map(([name, connection]) => {
        const healthEnabled = !isSdkMcpServerHandle(connection.config)
          && (connection.config.healthCheck?.enabled ?? false);
        return {
          name,
          status: connection.status,
          ...(connection.connectedAt ? { connectedAt: connection.connectedAt } : {}),
          ...(connection.error ? { error: connection.error } : {}),
          auth: {
            enabled: !isSdkMcpServerHandle(connection.config)
              && (connection.config.oauth?.enabled ?? false),
            ...(!isSdkMcpServerHandle(connection.config) && connection.config.oauth?.provider
              ? { provider: connection.config.oauth.provider }
              : {}),
          },
          health: {
            enabled: healthEnabled,
            status: healthEnabled ? 'unknown' as const : 'disabled' as const,
          },
          tools: connection.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? `MCP tool: ${tool.name}`,
            inputSchema: tool.inputSchema,
          })),
        };
      });
    },
    registerInProcessServer(serverName, handle) {
      return register(serverName, handle);
    },
    registerServer(serverName, config) {
      return register(serverName, config);
    },
    ensureServerRegistered(serverName, config) {
      return register(serverName, config);
    },
    connectServer: connect,
    disconnectServer: disconnect,
    async reconnectServer(serverName) {
      await disconnect(serverName);
      await connect(serverName);
    },
    async getAvailableToolsByServerNames(serverNames) {
      return createMcpTools(connections, serverNames);
    },
  };
}

async function createTransport(
  config: McpServerConfig | SdkMcpServerHandle,
): Promise<Transport> {
  if (isSdkMcpServerHandle(config)) {
    return await config.createClientTransport() as Transport;
  }

  const type = config.type ?? 'stdio';
  if (type === 'stdio') {
    if (!config.command) throw new Error('MCP stdio transport requires command');
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        ...config.env,
      },
      stderr: 'ignore',
    });
  }

  if (!config.url) throw new Error(`MCP ${type} transport requires url`);
  const requestInit = { headers: config.headers };
  return type === 'sse'
    ? new SSEClientTransport(new URL(config.url), { requestInit })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
}

function isSdkMcpServerHandle(
  config: McpServerConfig | SdkMcpServerHandle,
): config is SdkMcpServerHandle {
  return 'createClientTransport' in config;
}

function createMcpTools(
  connections: Map<string, DefaultMcpServerConnection>,
  serverNames: string[],
): Tool[] {
  const targetNames = new Set(serverNames);
  const nameCounts = new Map<string, number>();

  for (const [serverName, connection] of connections) {
    if (!targetNames.has(serverName) || connection.status !== 'connected') continue;
    for (const tool of connection.tools) {
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }
  }

  const tools: Tool[] = [];
  for (const [serverName, connection] of connections) {
    if (!targetNames.has(serverName) || connection.status !== 'connected' || !connection.client) {
      continue;
    }
    for (const tool of connection.tools) {
      const exposedName = (nameCounts.get(tool.name) ?? 0) > 1
        ? `${serverName}__${tool.name}`
        : tool.name;
      tools.push(createMcpTool(connection.client, serverName, exposedName, tool));
    }
  }
  return tools;
}

function createMcpTool(
  client: Client,
  serverName: string,
  exposedName: string,
  definition: McpToolDefinition,
): Tool {
  return toolFromDefinition({
    name: exposedName,
    displayName: `${serverName}: ${definition.name}`,
    description: definition.description ?? `MCP tool: ${definition.name}`,
    parameters: definition.inputSchema as never,
    kind: ToolKind.Execute,
    category: 'MCP tool',
    tags: ['mcp', 'external', serverName],
    async execute(params) {
      try {
        return mcpCallResultToToolResult(
          await client.callTool({ name: definition.name, arguments: params }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          llmContent: `MCP tool execution failed: ${message}`,
          error: { type: ToolErrorType.EXECUTION_ERROR, message },
        };
      }
    },
  });
}

function mcpCallResultToToolResult(result: Awaited<ReturnType<Client['callTool']>>): ToolResult {
  if (!isCallToolResult(result)) {
    return {
      success: false,
      llmContent: 'MCP task-based tool results are not supported by this session runtime',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'MCP task-based tool results are not supported',
      },
    };
  }

  const chunks = result.content.flatMap((item) => {
    if (item.type === 'text') return [item.text];
    if (item.type === 'image' || item.type === 'audio') return [`[${item.type}: ${item.mimeType}]`];
    if (item.type === 'resource_link') return [`[resource: ${item.uri}]`];
    if (item.type === 'resource') return ['[resource]'];
    return [];
  });
  const llmContent = chunks.join('\n')
    || (result.structuredContent ? JSON.stringify(result.structuredContent) : 'Execution succeeded');

  return result.isError
    ? {
        success: false,
        llmContent,
        error: { type: ToolErrorType.EXECUTION_ERROR, message: llmContent },
      }
    : {
        success: true,
        llmContent,
        metadata: { mcpResult: result },
      };
}

function isCallToolResult(
  result: Awaited<ReturnType<Client['callTool']>>,
): result is CallToolResult {
  return Array.isArray((result as { content?: unknown }).content);
}
