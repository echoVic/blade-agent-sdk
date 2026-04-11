import { z } from 'zod';
import type { McpRegistry } from '../../../mcp/McpRegistry.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

const ReadMcpResourceParamsSchema = z.object({
  uri: z.string().describe('The URI of the MCP resource to read'),
  serverName: z
    .string()
    .optional()
    .describe('Optional: The name of the MCP server that provides this resource. If not provided, will search all connected servers.'),
});

type ReadMcpResourceParams = z.infer<typeof ReadMcpResourceParamsSchema>;

interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export function createReadMcpResourceTool(registry: McpRegistry) {
  return createTool({
    name: 'ReadMcpResource',
    displayName: 'Read MCP Resource',
    kind: ToolKind.ReadOnly,
    description: {
      short: 'Read the contents of an MCP resource by URI',
      long: `Reads and returns the contents of a resource from a connected MCP (Model Context Protocol) server.
Resources are identified by their URI, which can be obtained using the ListMcpResources tool.

The resource content can be text (returned as-is) or binary data (returned as base64-encoded blob).`,
      usageNotes: [
        'Read a resource: ReadMcpResource({ uri: "file:///path/to/resource" })',
        'Read from specific server: ReadMcpResource({ uri: "db://table/record", serverName: "database-server" })',
      ],
    },
    schema: ReadMcpResourceParamsSchema,

    async execute(params: ReadMcpResourceParams) {
      try {
        const servers = registry.getAllServers();

      if (servers.size === 0) {
        return {
          success: false,
          llmContent: 'No MCP servers are currently connected.',
          error: {
            message: 'No MCP servers connected',
            type: ToolErrorType.EXECUTION_ERROR,
          },
          metadata: {
            summary: '无 MCP 服务器',
          },
        };
      }

      let content: ResourceContent | null = null;
      let foundServer: string | null = null;
      const errors: string[] = [];

      for (const [serverName, serverInfo] of servers) {
        if (params.serverName && serverName !== params.serverName) {
          continue;
        }

        if (!serverInfo.client) {
          continue;
        }

        try {
          const result = await serverInfo.client.readResource(params.uri, serverName);
          content = result as ResourceContent;
          foundServer = serverName;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('not found') && !message.includes('does not exist')) {
            errors.push(`${serverName}: ${message}`);
          }
        }
      }

      if (!content) {
        const errorMessage = params.serverName
          ? `Resource "${params.uri}" not found on server "${params.serverName}".`
          : `Resource "${params.uri}" not found on any connected MCP server.`;

        return {
          success: false,
          llmContent: errorMessage + (errors.length > 0 ? `\n\nErrors:\n${errors.join('\n')}` : ''),
          error: {
            message: errorMessage,
            type: ToolErrorType.EXECUTION_ERROR,
          },
          metadata: {
            summary: '未找到 MCP 资源',
          },
        };
      }

      let llmContent: string;

      if (content.text !== undefined) {
        llmContent = content.text;
      } else if (content.blob !== undefined) {
        llmContent = `[Binary content, base64 encoded, ${content.blob.length} characters]\n\n${content.blob.slice(0, 1000)}${content.blob.length > 1000 ? '...' : ''}`;
      } else {
        llmContent = JSON.stringify(content, null, 2);
      }

      return {
        success: true,
        llmContent,
        metadata: {
          summary: `读取 MCP 资源: ${params.uri}`,
          uri: params.uri,
          serverName: foundServer,
          mimeType: content.mimeType,
          hasText: content.text !== undefined,
          hasBlob: content.blob !== undefined,
          contentLength: content.text?.length ?? content.blob?.length ?? 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        llmContent: `Failed to read MCP resource: ${message}`,
        error: {
          message,
          type: ToolErrorType.EXECUTION_ERROR,
        },
        metadata: {
          summary: 'MCP 资源读取失败',
        },
      };
    }
  },
  });
}
