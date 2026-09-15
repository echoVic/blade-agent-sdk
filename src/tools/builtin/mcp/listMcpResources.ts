import Type from 'typebox';
import type { JsonValue } from '../../../types/json.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';

const ListMcpResourcesParamsSchema = Type.Object({
  serverName: Type.Optional(
    Type.String({
      description:
        'Optional: Filter resources by MCP server name. If not provided, lists resources from all connected servers.',
    }),
  ),
});

type ListMcpResourcesParams = Type.Static<typeof ListMcpResourcesParamsSchema>;

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

function parseMcpResource(value: JsonValue): Omit<McpResource, 'serverName'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('MCP resource must be an object');
  }
  if (typeof value.uri !== 'string') {
    throw new TypeError('MCP resource URI must be a string');
  }
  if (typeof value.name !== 'string') {
    throw new TypeError('MCP resource name must be a string');
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new TypeError('MCP resource description must be a string');
  }
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') {
    throw new TypeError('MCP resource mimeType must be a string');
  }
  return {
    uri: value.uri,
    name: value.name,
    description: value.description,
    mimeType: value.mimeType,
  };
}

export const listMcpResourcesTool = createTool({
  name: 'ListMcpResources',
  displayName: 'List MCP Resources',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  services: ['mcpRegistry'],
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
  schema: lazySchema(() => ListMcpResourcesParamsSchema),

  async *execute(params: ListMcpResourcesParams, context) {
    const registry = context.mcpRegistry;
    try {
      const servers = registry.getAllServers();

      if (servers.size === 0) {
        return {
          status: 'success',
          model: 'No MCP servers are currently connected.',
          metadata: {
            summary: '无 MCP 服务器',
            resources: [],
            serverCount: 0,
          },
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

          for (const value of resources) {
            const resource = parseMcpResource(value);
            allResources.push({
              ...resource,
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
          status: 'success',
          model: message + (errors.length > 0 ? `\n\nErrors:\n${errors.join('\n')}` : ''),
          metadata: {
            summary: `列出 ${allResources.length} 个 MCP 资源`,
            resources: [],
            errors,
          },
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
        status: 'success',
        model: `${summary}\n\n${resourceList}`,
        metadata: {
          summary: `列出 ${allResources.length} 个 MCP 资源`,
          resources: allResources,
          resourceCount: allResources.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'error',
        model: `Failed to list MCP resources: ${message}`,
        error: {
          message,
          type: ToolErrorType.EXECUTION_ERROR,
        },
        metadata: {
          summary: 'MCP 资源列出失败',
        },
      };
    }
  },
});
