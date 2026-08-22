/**
 * 内置工具模块
 */

import { SubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type { McpRegistry } from '../../mcp/McpRegistry.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';
import { SessionId } from '../../types/branded.js';
import type { Tool } from '../types/index.js';
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
  sessionId?: SessionId;
  configDir?: string;
  mcpRegistry?: McpRegistry;
  includeMcpProtocolTools?: boolean;
  memoryManager?: MemoryManager;
  subagentRegistry?: SubagentRegistry;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId ?? SessionId(`session_${Date.now()}`);
  const configDir = opts?.configDir;
  const registry = opts?.subagentRegistry ?? new SubagentRegistry();
  if (!opts?.subagentRegistry) {
    registry.loadFromStandardLocations(undefined, configDir);
  }

  const builtinTools = flattenBuiltinToolGroups(
    createBuiltinToolGroups({
      sessionId,
      configDir,
      mcpRegistry: opts?.mcpRegistry,
      memoryManager: opts?.memoryManager,
      subagentRegistry: registry,
    }),
  );

  // 添加 MCP 协议工具
  const mcpTools =
    opts?.mcpRegistry && opts.includeMcpProtocolTools !== false
      ? await getMcpTools(opts.mcpRegistry)
      : [];

  return [...builtinTools, ...mcpTools];
}
