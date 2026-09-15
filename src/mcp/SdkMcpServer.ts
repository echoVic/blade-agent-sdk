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
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type Type from 'typebox';
import { compileToolInput } from '../tools/validation/toolInput.js';

export type ToolResponse = CallToolResult;

/**
 * A single tool definition for the in-process MCP server
 */
export interface SdkTool<TSchema extends Type.TObject = Type.TObject> {
  name: string;
  description: string;
  schema: TSchema;
  handler(params: Type.Static<TSchema>): Promise<ToolResponse>;
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
 *   Type.Object({ name: Type.String({ description: 'The user name' }) }),
 *   async (params) => ({
 *     content: [{ type: 'text', text: `Hello, ${params.name}!` }],
 *   })
 * );
 * ```
 */
export function tool<TSchema extends Type.TObject>(
  name: string,
  description: string,
  schema: TSchema,
  handler: (params: Type.Static<TSchema>) => Promise<ToolResponse>,
): SdkTool<TSchema> {
  return {
    name,
    description,
    schema,
    handler,
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

  const tools = new Map(
    config.tools.map((sdkTool) => [
      sdkTool.name,
      {
        definition: sdkTool,
        input: compileToolInput(sdkTool.schema),
      },
    ]),
  );
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.schema,
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const registered = tools.get(request.params.name);
    if (!registered) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }
    try {
      const params = registered.input.parse(request.params.arguments ?? {});
      return await registered.definition.handler(params);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : 'Invalid tool input',
          },
        ],
      };
    }
  });

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
