/**
 * 内置工具模块
 */

import type { McpRegistry } from '../../mcp/McpRegistry.js';
import type { Tool } from '../types/tool.js';
import { editTool, readTool, writeTool } from './file/index.js';
import { listMcpResourcesTool, readMcpResourceTool } from './mcp/index.js';
import { memoryReadTool, memoryWriteTool } from './memory/index.js';
import { notebookEditTool } from './notebook/index.js';
import { enterPlanModeTool, exitPlanModeTool } from './plan/index.js';
import { globTool, grepTool } from './search/index.js';
import { bashTool, killShellTool } from './shell/index.js';
import { askUserQuestionTool, discoverToolsTool, skillTool } from './system/index.js';
import {
  taskCreateTool,
  taskGetTool,
  taskListTool,
  taskOutputTool,
  taskStopTool,
  taskTool,
  taskUpdateTool,
} from './task/index.js';
import { todoWriteTool } from './todo/index.js';
import { webFetchTool, webSearchTool } from './web/index.js';

export const builtinTools: readonly Tool[] = Object.freeze([
  readTool,
  editTool,
  writeTool,
  notebookEditTool,
  globTool,
  grepTool,
  bashTool,
  killShellTool,
  webFetchTool,
  webSearchTool,
  taskTool,
  taskOutputTool,
  taskCreateTool,
  taskGetTool,
  taskUpdateTool,
  taskListTool,
  taskStopTool,
  todoWriteTool,
  memoryReadTool,
  memoryWriteTool,
  enterPlanModeTool,
  exitPlanModeTool,
  askUserQuestionTool,
  discoverToolsTool,
  skillTool,
  listMcpResourcesTool,
  readMcpResourceTool,
]);

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
  // 添加 MCP 协议工具
  const mcpTools =
    opts?.mcpRegistry && opts.includeMcpProtocolTools !== false
      ? await getMcpTools(opts.mcpRegistry)
      : [];

  return [...builtinTools, ...mcpTools];
}
