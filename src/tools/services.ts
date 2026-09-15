import type { SubagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { IBackgroundAgentManager } from '../agent/types.js';
import type { McpRegistry } from '../mcp/McpRegistry.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';

export interface ToolServiceMap {
  subagentRegistry: SubagentRegistry;
  memoryManager: MemoryManager;
  mcpRegistry: McpRegistry;
  skillRegistry: SkillRegistry;
  backgroundAgentManager: IBackgroundAgentManager;
}

export type ToolServiceName = keyof ToolServiceMap;
export type ToolServices = Partial<ToolServiceMap>;

export interface ToolServiceSelection {
  readonly selected: ToolServices;
  readonly missing: readonly ToolServiceName[];
}

export function selectToolServices(
  available: ToolServices,
  requested: readonly ToolServiceName[] = [],
): ToolServiceSelection {
  const selected: ToolServices = {};
  const missing: ToolServiceName[] = [];

  for (const name of requested) {
    switch (name) {
      case 'subagentRegistry':
        if (available.subagentRegistry) selected.subagentRegistry = available.subagentRegistry;
        else missing.push(name);
        break;
      case 'memoryManager':
        if (available.memoryManager) selected.memoryManager = available.memoryManager;
        else missing.push(name);
        break;
      case 'mcpRegistry':
        if (available.mcpRegistry) selected.mcpRegistry = available.mcpRegistry;
        else missing.push(name);
        break;
      case 'skillRegistry':
        if (available.skillRegistry) selected.skillRegistry = available.skillRegistry;
        else missing.push(name);
        break;
      case 'backgroundAgentManager':
        if (available.backgroundAgentManager) {
          selected.backgroundAgentManager = available.backgroundAgentManager;
        } else {
          missing.push(name);
        }
        break;
    }
  }

  return { selected, missing };
}
