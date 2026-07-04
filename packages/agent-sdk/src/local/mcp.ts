import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { JsonObject } from '../types/common.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpToolCallResponse {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: JsonObject;
}

export type ToolResponse = CallToolResult;
export type McpToolResponse = ToolResponse;

export interface SdkTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (params: JsonObject) => Promise<ToolResponse>;
}

export interface SdkMcpServerHandle {
  name: string;
  version: string;
  createClientTransport: () => Promise<Transport>;
  server: McpServer;
}

export function tool<TSchema extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  schema: TSchema,
  handler: (params: { [K in keyof TSchema]: z.infer<TSchema[K]> }) => Promise<ToolResponse>,
): SdkTool {
  return {
    name,
    description,
    schema,
    handler: handler as (params: JsonObject) => Promise<ToolResponse>,
  };
}

export async function createSdkMcpServer(config: {
  name: string;
  version: string;
  tools: SdkTool[];
}): Promise<SdkMcpServerHandle> {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  for (const sdkTool of config.tools) {
    server.tool(
      sdkTool.name,
      sdkTool.description,
      sdkTool.schema,
      async (params) => sdkTool.handler(params as JsonObject),
    );
  }

  return {
    name: config.name,
    version: config.version,
    createClientTransport: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      return clientTransport;
    },
    server,
  };
}
