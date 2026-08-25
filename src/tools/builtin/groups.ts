import type { SubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type { McpRegistry } from '../../mcp/McpRegistry.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';
import type { SessionId } from '../../types/identifiers.js';
import type { Tool } from '../types/tool.js';
import { editTool, readTool, writeTool } from './file/index.js';
import { createListMcpResourcesTool, createReadMcpResourceTool } from './mcp/index.js';
import { createMemoryReadTool, createMemoryWriteTool } from './memory/index.js';
import { notebookEditTool } from './notebook/index.js';
import { enterPlanModeTool, exitPlanModeTool } from './plan/index.js';
import { globTool, grepTool } from './search/index.js';
import { bashTool, killShellTool } from './shell/index.js';
import { askUserQuestionTool, discoverToolsTool, skillTool } from './system/index.js';
import {
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskStopTool,
  createTaskTool,
  createTaskUpdateTool,
  taskOutputTool,
} from './task/index.js';
import { createTodoWriteTool } from './todo/index.js';
import { webFetchTool, webSearchTool } from './web/index.js';

export interface BuiltinToolGroups {
  filesystem: Tool[];
  shell: Tool[];
  web: Tool[];
  task: Tool[];
  memory: Tool[];
  system: Tool[];
  mcpResources: Tool[];
}

interface BuiltinToolGroupOptions {
  sessionId: SessionId;
  configDir?: string;
  mcpRegistry?: McpRegistry;
  memoryManager?: MemoryManager;
  subagentRegistry: SubagentRegistry;
}

export function createBuiltinToolGroups(options: BuiltinToolGroupOptions): BuiltinToolGroups {
  const { sessionId, configDir, mcpRegistry, memoryManager, subagentRegistry } = options;

  return {
    filesystem: [readTool, editTool, writeTool, notebookEditTool, globTool, grepTool],
    shell: [bashTool, killShellTool],
    web: [webFetchTool, webSearchTool],
    task: [
      createTaskTool({ registry: subagentRegistry }),
      taskOutputTool,
      createTaskCreateTool({ sessionId }),
      createTaskGetTool({ sessionId }),
      createTaskUpdateTool({ sessionId }),
      createTaskListTool({ sessionId }),
      createTaskStopTool({ sessionId }),
      createTodoWriteTool({ sessionId, configDir }),
    ],
    memory: memoryManager
      ? [
          createMemoryReadTool({ manager: memoryManager }),
          createMemoryWriteTool({ manager: memoryManager }),
        ]
      : [],
    system: [
      enterPlanModeTool,
      exitPlanModeTool,
      askUserQuestionTool,
      discoverToolsTool,
      skillTool,
    ],
    mcpResources: mcpRegistry
      ? [createListMcpResourcesTool(mcpRegistry), createReadMcpResourceTool(mcpRegistry)]
      : [],
  };
}

export function flattenBuiltinToolGroups(groups: BuiltinToolGroups): Tool[] {
  return [
    ...groups.filesystem,
    ...groups.shell,
    ...groups.web,
    ...groups.task,
    ...groups.memory,
    ...groups.system,
    ...groups.mcpResources,
  ];
}
