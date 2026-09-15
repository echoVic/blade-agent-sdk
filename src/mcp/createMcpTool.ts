import Type from 'typebox';
import type { JsonObject } from '../types/json.js';
import { createTool } from '../tools/core/createTool.js';
import { ToolKind } from '../tools/types/kind.js';
import { ToolErrorType } from '../tools/types/result.js';
import { compileToolInput } from '../tools/validation/toolInput.js';
import { getErrorMessage } from '../utils/errorUtils.js';
import type { McpClient } from './McpClient.js';
import { createMcpServerTag, createMcpToolName } from './toolSource.js';
import type { McpToolDefinition } from './types.js';

/**
 * 将 MCP 工具定义转换为 Blade Tool 实例
 */
export function createMcpTool(
  mcpClient: McpClient,
  serverName: string,
  toolDef: McpToolDefinition,
  customName?: string, // 可选的自定义工具名（用于冲突处理）
) {
  // MCP owns a raw JSON Schema boundary. TypeBox compiles that schema directly.
  let parameters: Type.TUnsafe<JsonObject>;
  if (toolDef.inputSchema === undefined) {
    parameters = Type.Unsafe<JsonObject>(Type.Object({}));
  } else {
    try {
      assertResolvableLocalRefs(toolDef.inputSchema);
      parameters = toolDef.inputSchema as Type.TUnsafe<JsonObject>;
      compileToolInput(parameters);
    } catch (error) {
      console.warn(`[createMcpTool] Schema 编译失败，使用降级 schema: ${toolDef.name}`, error);
      parameters = Type.Unsafe<JsonObject>({
        type: 'object',
        additionalProperties: true,
      });
    }
  }

  const toolName = customName || createMcpToolName(serverName, toolDef.name);

  return createTool({
    name: toolName,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.Execute,
    sideEffect: 'non_idempotent',
    schema: parameters,
    description: {
      short: toolDef.description || `MCP Tool: ${toolDef.name}`,
      important: [
        `From MCP server: ${serverName}`,
        'Executes external tools; user confirmation required',
      ],
    },
    category: 'MCP tool',
    tags: ['mcp', 'external', serverName, createMcpServerTag(serverName)],

    // biome-ignore lint/correctness/useYield: terminal-only tool execution
    async *execute(params, _context) {
      try {
        const result = await mcpClient.callTool(toolDef.name, params);

        // 处理 MCP 响应内容
        let modelContent = '';

        if (result.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item.type === 'text' && item.text) {
              modelContent += item.text;
            } else if (item.type === 'image') {
              modelContent += `[image: ${item.mimeType || 'unknown'}]\n`;
            } else if (item.type === 'resource') {
              modelContent += `[resource: ${item.mimeType || 'unknown'}]\n`;
            }
          }
        }

        if (result.isError) {
          return {
            status: 'error',
            model: modelContent || 'MCP tool execution failed',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: modelContent || 'MCP tool execution failed',
            },
            metadata: {
              summary: `MCP ${toolDef.name} 执行失败`,
            },
          };
        }

        return {
          status: 'success',
          model: modelContent || 'Execution succeeded',
          metadata: {
            summary: `MCP ${toolDef.name} 执行成功`,
            serverName,
            toolName: toolDef.name,
            mcpResult: result,
          },
        };
      } catch (error) {
        return {
          status: 'error',
          model: `MCP tool execution failed: ${getErrorMessage(error)}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: getErrorMessage(error),
          },
          metadata: {
            summary: `MCP ${toolDef.name} 执行异常`,
          },
        };
      }
    },
  });
}

function assertResolvableLocalRefs(schema: object): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      resolveLocalRef(record.$ref, schema);
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(schema);
}

function resolveLocalRef(ref: string, rootSchema: object): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported schema ref: ${ref}`);
  }

  let current: unknown = rootSchema;
  for (const segment of ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new Error(`Unable to resolve schema ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
