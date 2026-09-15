/**
 * 内置工具模块
 */

import type { McpRegistry } from '../../mcp/McpRegistry.js';
import type { Tool } from '../types/tool.js';
import { createBuiltinToolGroups, flattenBuiltinToolGroups } from './groups.js';

async function getMcpTools(mcpRegistry: McpRegistry): Promise<Tool[]> {
  try {
    return await mcpRegistry.getAvailableTools();
  } catch (error) {
    console.warn('MCP协议工具加载失败:', error);
    return [];
  }
}

/**
 * 获取所有内置工具
 */
export async function getBuiltinTools(opts?: {
  mcpRegistry?: McpRegistry;
  includeMcpProtocolTools?: boolean;
}): Promise<Tool[]> {
  const builtinTools = flattenBuiltinToolGroups(createBuiltinToolGroups());

  // 添加 MCP 协议工具
  const mcpTools =
    opts?.mcpRegistry && opts.includeMcpProtocolTools !== false
      ? await getMcpTools(opts.mcpRegistry)
      : [];

  return [...builtinTools, ...mcpTools];
}
