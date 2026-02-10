/**
 * In-Process MCP Server
 *
 * Allows consumers to define custom tools using the standard MCP protocol
 * and register them as an in-process MCP server (no external process needed).
 *
 * Uses @modelcontextprotocol/sdk's McpServer + InMemoryTransport.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export type ToolResponse = CallToolResult;

/**
 * A single tool definition for the in-process MCP server
 */
export interface SdkTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (params: Record<string, unknown>) => Promise<ToolResponse>;
}

/**
 * Handle returned by createSdkMcpServer()
 *
 * Instead of holding a single transport (which cannot be reused after close),
 * this handle provides a factory function to create new transport pairs on demand.
 * This enables reconnection and multiple client connections.
 */
export interface SdkMcpServerHandle {
  name: string;
  version: string;
  /**
   * Creates a new client transport connected to the server.
   * Each call returns a fresh transport pair, enabling reconnection.
   */
  createClientTransport: () => Promise<Transport>;
  server: McpServer;
}

/**
 * Factory function to define a single MCP tool with typed schema.
 *
 * @example
 * ```ts
 * const myTool = tool(
 *   'greet',
 *   'Greet a user by name',
 *   { name: z.string().describe('The user name') },
 *   async (params) => ({
 *     content: [{ type: 'text', text: `Hello, ${params.name}!` }],
 *   })
 * );
 * ```
 */
export function tool<T extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  schema: T,
  handler: (params: { [K in keyof T]: z.infer<T[K]> }) => Promise<ToolResponse>,
): SdkTool {
  return {
    name,
    description,
    schema,
    handler: handler as (params: Record<string, unknown>) => Promise<ToolResponse>,
  };
}

/**
 * Create an in-process MCP server from a list of tool definitions.
 *
 * Returns a handle that can be passed to SessionOptions.mcpServers.
 * The handle provides a factory function to create new client transports,
 * enabling reconnection and multiple client connections.
 *
 * @example
 * ```ts
 * const handle = await createSdkMcpServer({
 *   name: 'my-tools',
 *   version: '1.0.0',
 *   tools: [myTool1, myTool2],
 * });
 *
 * // Use in session:
 * const session = await createSession({
 *   ...config,
 *   mcpServers: { 'my-tools': handle },
 * });
 * ```
 */
export async function createSdkMcpServer(config: {
  name: string;
  version: string;
  tools: SdkTool[];
}): Promise<SdkMcpServerHandle> {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  for (const t of config.tools) {
    server.tool(t.name, t.description, t.schema, async (params) => {
      return t.handler(params as Record<string, unknown>);
    });
  }

  const createClientTransport = async (): Promise<Transport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };

  return {
    name: config.name,
    version: config.version,
    createClientTransport,
    server,
  };
}
