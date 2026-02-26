import { z } from 'zod';
import type { McpRegistry } from '../../../mcp/McpRegistry.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

const ListMcpResourcesParamsSchema = z.object({
  serverName: z
    .string()
    .optional()
    .describe('Optional: Filter resources by MCP server name. If not provided, lists resources from all connected servers.'),
});

type ListMcpResourcesParams = z.infer<typeof ListMcpResourcesParamsSchema>;

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export function createListMcpResourcesTool(registry: McpRegistry) {
  return createTool({
    name: 'ListMcpResources',
    displayName: 'List MCP Resources',
    kind: ToolKind.ReadOnly,
    description: {
      short: 'List resources available from connected MCP servers',
      long: `Lists all resources provided by connected MCP (Model Context Protocol) servers.
Resources can include files, database records, API endpoints, or any other data sources
that MCP servers expose for reading.

Use this tool to discover what resources are available before using ReadMcpResource to
access their contents.`,
      usageNotes: [
        'List all resources: ListMcpResources({})',
        'List resources from specific server: ListMcpResources({ serverName: "my-server" })',
      ],
    },
    schema: ListMcpResourcesParamsSchema,

    async execute(params: ListMcpResourcesParams) {
      try {
        const servers = registry.getAllServers();

      if (servers.size === 0) {
        return {
          success: true,
          llmContent: 'No MCP servers are currently connected.',
          displayContent: 'No MCP servers connected',
          metadata: { resources: [], serverCount: 0 },
        };
      }

      const allResources: McpResource[] = [];
      const errors: string[] = [];

      for (const [serverName, serverInfo] of servers) {
        if (params.serverName && serverName !== params.serverName) {
          continue;
        }

        if (!serverInfo.client) {
          continue;
        }

        try {
          const resources = await serverInfo.client.listResources(serverName);

          for (const resource of resources as Array<{
            uri: string;
            name: string;
            description?: string;
            mimeType?: string;
          }>) {
            allResources.push({
              uri: resource.uri,
              name: resource.name,
              description: resource.description,
              mimeType: resource.mimeType,
              serverName,
            });
          }
        } catch (error) {
          errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (allResources.length === 0) {
        const message = params.serverName
          ? `No resources found from server "${params.serverName}".`
          : 'No resources found from any connected MCP server.';

        return {
          success: true,
          llmContent: message + (errors.length > 0 ? `\n\nErrors:\n${errors.join('\n')}` : ''),
          displayContent: message,
          metadata: { resources: [], errors },
        };
      }

      const resourceList = allResources
        .map((r) => {
          let line = `- ${r.uri} (${r.name})`;
          if (r.description) line += `\n  ${r.description}`;
          if (r.mimeType) line += `\n  Type: ${r.mimeType}`;
          line += `\n  Server: ${r.serverName}`;
          return line;
        })
        .join('\n\n');

      const summary = `Found ${allResources.length} resource(s) from ${new Set(allResources.map((r) => r.serverName)).size} server(s)`;

      return {
        success: true,
        llmContent: `${summary}\n\n${resourceList}`,
        displayContent: summary,
        metadata: {
          resources: allResources,
          resourceCount: allResources.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        llmContent: `Failed to list MCP resources: ${message}`,
        displayContent: 'Failed to list resources',
        error: {
          message,
          type: ToolErrorType.EXECUTION_ERROR,
        },
      };
    }
  },
  });
}
