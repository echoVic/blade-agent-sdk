/**
 * 内置工具模块 — 委托到 @blade-ai/agent-sdk/local
 */

import type { McpRegistry } from '../../mcp/McpRegistry.js';
import { SessionId } from '@blade-ai/agent-sdk/local';
import type { Tool } from '../types/index.js';
import { getBuiltinTools as getPackageBuiltinTools } from '@blade-ai/agent-sdk/local';
import { SubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type { MemoryManager } from '@blade-ai/agent-sdk/local';

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
  subagentRegistry?: SubagentRegistry;
}): Promise<Tool[]> {
  const sessionId = opts?.sessionId ?? SessionId(`session_${Date.now()}`);
  const registry = opts?.subagentRegistry ?? new SubagentRegistry();
  if (!opts?.subagentRegistry) {
    registry.loadFromStandardLocations(undefined, opts?.configDir);
  }

  const tools = await getPackageBuiltinTools({
    sessionId,
    configDir: opts?.configDir,
    mcpRegistry: opts?.mcpRegistry,
    includeMcpProtocolTools: opts?.includeMcpProtocolTools,
    memoryManager: opts?.memoryManager,
    subagentRegistry: registry,
  }) as Tool[];

  const mcpTools = opts?.mcpRegistry && opts?.includeMcpProtocolTools !== false
    ? await getMcpTools(opts.mcpRegistry)
    : [];

  return [...tools, ...mcpTools];
}
