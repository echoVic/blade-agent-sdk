/**
 * 内置工具模块 — 集成在 @blade-ai/agent-sdk/tools/builtin
 */

import type { McpRegistry } from '../../local/McpRegistry.js';
import { SessionId } from '../../local/branded.js';
import type { Tool } from '../types/index.js';
import type { MemoryManager } from '../../local/MemoryManager.js';
import type { SubagentRegistryLike } from '../../local/subagentTypes.js';
import { SubagentRegistry } from '../../local/subagentRegistry.js';
import { getBuiltinTools as getLocalBuiltinTools } from '../../local/builtin-tools.js';

async function getMcpTools(mcpRegistry: McpRegistry): Promise<Tool[]> {
  try {
    return await mcpRegistry.getConnectedTools();
  } catch (error) {
    console.warn('MCP协议工具加载失败:', error);
    return [];
  }
}

export async function getBuiltinTools(opts?: {
  sessionId?: SessionId;
  configDir?: string;
  mcpRegistry?: McpRegistry;
  includeMcpProtocolTools?: boolean;
  memoryManager?: MemoryManager;
  subagentRegistry?: SubagentRegistryLike;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId ?? SessionId(`session_${Date.now()}`);
  const registry = opts?.subagentRegistry ?? new SubagentRegistry();
  if (!opts?.subagentRegistry) {
    registry.loadFromStandardLocations(undefined, opts?.configDir);
  }

  const tools = await getLocalBuiltinTools({
    sessionId,
    configDir: opts?.configDir,
    mcpRegistry: opts?.mcpRegistry,
    includeMcpProtocolTools: opts?.includeMcpProtocolTools,
    memoryManager: opts?.memoryManager,
    subagentRegistry: registry,
  });

  const mcpTools = opts?.mcpRegistry && opts?.includeMcpProtocolTools !== false
    ? await getMcpTools(opts.mcpRegistry)
    : [];

  return [...tools, ...mcpTools];
}
