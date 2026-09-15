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

export interface BuiltinToolGroups {
  filesystem: Tool[];
  shell: Tool[];
  web: Tool[];
  task: Tool[];
  memory: Tool[];
  system: Tool[];
  mcpResources: Tool[];
}

export function createBuiltinToolGroups(): BuiltinToolGroups {
  return {
    filesystem: [readTool, editTool, writeTool, notebookEditTool, globTool, grepTool],
    shell: [bashTool, killShellTool],
    web: [webFetchTool, webSearchTool],
    task: [
      taskTool,
      taskOutputTool,
      taskCreateTool,
      taskGetTool,
      taskUpdateTool,
      taskListTool,
      taskStopTool,
      todoWriteTool,
    ],
    memory: [memoryReadTool, memoryWriteTool],
    system: [
      enterPlanModeTool,
      exitPlanModeTool,
      askUserQuestionTool,
      discoverToolsTool,
      skillTool,
    ],
    mcpResources: [listMcpResourcesTool, readMcpResourceTool],
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
