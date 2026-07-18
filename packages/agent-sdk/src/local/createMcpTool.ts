/**
 * MCP Tool Creator
 *
 * Converts MCP tool definitions into Blade Tool instances.
 * Includes JSON Schema → Zod conversion with fallback.
 */

import type { JSONSchema7, JSONSchema7Type } from 'json-schema';
import { z } from 'zod';
import { createTool } from '../tools/index.js';
import { ToolKind } from '../tools/types/ToolKind.js';
import { ToolErrorType } from '../tools/types/index.js';
import { getErrorMessage } from '@blade-ai/agent/utils';
import type { McpClientLike, McpToolDefinition } from './mcpTypes.js';

/**
 * 将 MCP 工具定义转换为 Blade Tool 实例
 */
export function createMcpTool(
  mcpClient: McpClientLike,
  serverName: string,
  toolDef: McpToolDefinition,
  customName?: string // 可选的自定义工具名（用于冲突处理）
) {
  // 1. JSON Schema → Zod Schema 转换（带错误处理）
  let zodSchema: z.ZodSchema;
  try {
    zodSchema = convertJsonSchemaToZod(toolDef.inputSchema);
  } catch (error) {
    console.warn(
      `[createMcpTool] Schema 转换失败，使用降级 schema: ${toolDef.name}`,
      error
    );
    zodSchema = z.record(z.string(), z.unknown());
  }

  // 2. 决定工具名称
  const toolName = customName || toolDef.name;

  // 3. 使用 createTool 创建标准工具
  return createTool({
    name: toolName,
    displayName: `${serverName}: ${toolDef.name}`,
    kind: ToolKind.Execute, // MCP 外部工具视为 Execute 类型
    schema: zodSchema,
    description: {
      short: toolDef.description || `MCP Tool: ${toolDef.name}`,
      important: [
        `From MCP server: ${serverName}`,
        'Executes external tools; user confirmation required',
      ],
    },
    category: 'MCP tool',
    tags: ['mcp', 'external', serverName],

    async execute(params, _signal) {
      try {
        const result = await mcpClient.callTool(toolDef.name, params as Record<string, unknown>);

        // 处理 MCP 响应内容
        let llmContent = '';

        if (result.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (typeof item === 'object' && item !== null) {
              const contentItem = item as Record<string, unknown>;
              if (contentItem.type === 'text' && contentItem.text) {
                llmContent += String(contentItem.text);
              } else if (contentItem.type === 'image') {
                llmContent += `[image: ${contentItem.mimeType || 'unknown'}]\n`;
              } else if (contentItem.type === 'resource') {
                llmContent += `[resource: ${contentItem.mimeType || 'unknown'}]\n`;
              }
            }
          }
        }

        if (result.isError) {
          return {
            success: false,
            llmContent: llmContent || 'MCP tool execution failed',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: llmContent || 'MCP tool execution failed',
            },
            metadata: {
              summary: `MCP ${toolDef.name} 执行失败`,
            },
          };
        }

        return {
          success: true,
          llmContent: llmContent || 'Execution succeeded',
          metadata: {
            summary: `MCP ${toolDef.name} 执行成功`,
            serverName,
            toolName: toolDef.name,
            mcpResult: result,
          },
        };
      } catch (error) {
        return {
          success: false,
          llmContent: `MCP tool execution failed: ${getErrorMessage(error)}`,
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

/**
 * JSON Schema → Zod 转换辅助函数
 */
function convertJsonSchemaToZod(jsonSchema: JSONSchema7): z.ZodSchema {
  return convertSchemaNode(jsonSchema, jsonSchema);
}

function convertSchemaNode(
  jsonSchema: JSONSchema7,
  rootSchema: JSONSchema7,
): z.ZodTypeAny {
  if (jsonSchema.$ref) {
    const resolved = resolveSchemaRef(jsonSchema.$ref, rootSchema);
    return convertSchemaNode(resolved, rootSchema);
  }

  const explicitTypes = normalizeSchemaTypes(jsonSchema.type);
  if (jsonSchema.enum && jsonSchema.enum.length > 0) {
    return buildEnumSchema(jsonSchema.enum);
  }

  // 处理 object 类型
  if (explicitTypes.includes('object') || jsonSchema.type === 'object' || jsonSchema.properties) {
    return buildObjectSchema(jsonSchema, rootSchema);
  }

  // 处理 array 类型
  if (explicitTypes.includes('array') || jsonSchema.type === 'array' || jsonSchema.items) {
    return buildArraySchema(jsonSchema, rootSchema);
  }

  // 基础类型
  let schema: z.ZodTypeAny = z.unknown();

  if (explicitTypes.includes('string')) {
    schema = z.string();
    if (jsonSchema.minLength !== undefined) {
      schema = (schema as z.ZodString).min(jsonSchema.minLength);
    }
    if (jsonSchema.maxLength !== undefined) {
      schema = (schema as z.ZodString).max(jsonSchema.maxLength);
    }
    if (jsonSchema.pattern) {
      try {
        schema = (schema as z.ZodString).regex(new RegExp(jsonSchema.pattern));
      } catch {
        // 无效正则，忽略
      }
    }
  } else if (explicitTypes.includes('number') || explicitTypes.includes('integer')) {
    schema = z.number();
    if (jsonSchema.minimum !== undefined) {
      schema = (schema as z.ZodNumber).gte(jsonSchema.minimum);
    }
    if (jsonSchema.maximum !== undefined) {
      schema = (schema as z.ZodNumber).lte(jsonSchema.maximum);
    }
  } else if (explicitTypes.includes('boolean')) {
    schema = z.boolean();
  } else if (explicitTypes.includes('null')) {
    schema = z.null();
  }

  // 处理 anyOf
  if (jsonSchema.anyOf && jsonSchema.anyOf.length > 0) {
    const schemas = jsonSchema.anyOf
      .filter(
        (s): s is JSONSchema7 => typeof s === 'object' && s !== null
      )
      .map((s) => convertSchemaNode(s, rootSchema));
    if (schemas.length >= 2) {
      return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    if (schemas.length === 1) {
      return schemas[0];
    }
  }

  // 处理 oneOf
  if (jsonSchema.oneOf && jsonSchema.oneOf.length > 0) {
    const schemas = jsonSchema.oneOf
      .filter(
        (s): s is JSONSchema7 => typeof s === 'object' && s !== null
      )
      .map((s) => convertSchemaNode(s, rootSchema));
    if (schemas.length >= 2) {
      return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    if (schemas.length === 1) {
      return schemas[0];
    }
  }

  return applyNullable(schema, explicitTypes);
}

function buildObjectSchema(
  jsonSchema: JSONSchema7,
  rootSchema: JSONSchema7,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = jsonSchema.required || [];

  if (jsonSchema.properties) {
    for (const [key, value] of Object.entries(jsonSchema.properties)) {
      if (typeof value === 'object' && value !== null) {
        let fieldSchema = convertSchemaNode(value as JSONSchema7, rootSchema);
        if (!required.includes(key)) {
          fieldSchema = fieldSchema.optional();
        }
        shape[key] = fieldSchema;
      }
    }
  }

  const objectSchema = z.object(shape);
  if (jsonSchema.additionalProperties === true) {
    return objectSchema.catchall(z.unknown());
  }

  if (
    typeof jsonSchema.additionalProperties === 'object'
    && jsonSchema.additionalProperties !== null
    && !Array.isArray(jsonSchema.additionalProperties)
  ) {
    return objectSchema.catchall(
      convertSchemaNode(jsonSchema.additionalProperties as JSONSchema7, rootSchema),
    );
  }

  if (jsonSchema.additionalProperties === false) {
    return objectSchema.strict();
  }

  return objectSchema;
}

function buildArraySchema(
  jsonSchema: JSONSchema7,
  rootSchema: JSONSchema7,
): z.ZodTypeAny {
  if (
    typeof jsonSchema.items === 'object'
    && !Array.isArray(jsonSchema.items)
    && jsonSchema.items !== null
  ) {
    return z.array(convertSchemaNode(jsonSchema.items as JSONSchema7, rootSchema));
  }
  return z.array(z.unknown());
}

function buildEnumSchema(values: JSONSchema7['enum']): z.ZodTypeAny {
  if (!values || values.length === 0) {
    return z.unknown();
  }

  if (values.every((value) => typeof value === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }

  const literalValues = values.filter(isLiteralValue);
  if (literalValues.length !== values.length) {
    return z.unknown();
  }

  const literals = literalValues.map((value) =>
    z.literal(value as string | number | boolean | null)
  );
  if (literals.length === 1) {
    return literals[0];
  }
  return z.union(literals as [z.ZodLiteral<unknown>, z.ZodLiteral<unknown>, ...z.ZodLiteral<unknown>[]]);
}

function normalizeSchemaTypes(type: JSONSchema7['type']): JSONSchema7['type'][] {
  if (!type) {
    return [];
  }
  return Array.isArray(type) ? type : [type];
}

function applyNullable(schema: z.ZodTypeAny, explicitTypes: JSONSchema7['type'][]): z.ZodTypeAny {
  return explicitTypes.includes('null') ? schema.nullable() : schema;
}

function resolveSchemaRef(ref: string, rootSchema: JSONSchema7): JSONSchema7 {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported schema ref: ${ref}`);
  }

  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = rootSchema;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new Error(`Unable to resolve schema ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== 'object' || current === null) {
    throw new Error(`Resolved schema ref is not an object: ${ref}`);
  }

  return current as JSONSchema7;
}

function isLiteralValue(
  value: JSONSchema7Type,
): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}
