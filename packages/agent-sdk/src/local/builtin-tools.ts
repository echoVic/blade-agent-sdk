import type { Tool } from '../tools/types/index.js';
import { editTool, readTool, writeTool } from './file/index.js';
import { globTool, grepTool } from './search/index.js';
import { notebookEditTool } from './notebook/notebookEdit.js';
import { askUserQuestionTool } from './system/askUserQuestion.js';
import { discoverToolsTool } from './system/discoverTools.js';
import { enterPlanModeTool } from './plan/enterPlanMode.js';
import { exitPlanModeTool } from './plan/exitPlanMode.js';
import type { MemoryManager } from './memory.js';
import { createMemoryReadTool } from './memoryRead.js';
import { createMemoryWriteTool } from './memoryWrite.js';
import { createTodoWriteTool } from './todo/index.js';
import { createListMcpResourcesTool, createReadMcpResourceTool } from './mcp-tools/index.js';
import type { McpResourceRegistry } from './mcp-tools/listMcpResources.js';

export interface BuiltinToolsOptions {
  memoryManager?: MemoryManager;
  sessionId?: unknown;
  configDir?: string;
  mcpRegistry?: unknown;
  includeMcpProtocolTools?: boolean;
  subagentRegistry?: unknown;
}

export async function getBuiltinTools(options: BuiltinToolsOptions = {}): Promise<Tool[]> {
  const sessionId = String(options.sessionId ?? `session_${Date.now()}`);
  return [
    editTool,
    readTool,
    writeTool,
    grepTool,
    globTool,
    notebookEditTool,
    askUserQuestionTool,
    enterPlanModeTool,
    exitPlanModeTool,
    createTodoWriteTool({ sessionId, configDir: options.configDir }),
    discoverToolsTool,
    ...(options.includeMcpProtocolTools && options.mcpRegistry
      ? [
          createListMcpResourcesTool(options.mcpRegistry as McpResourceRegistry),
          createReadMcpResourceTool(options.mcpRegistry as McpResourceRegistry),
        ]
      : []),
    ...(options.memoryManager
      ? [
          createMemoryReadTool({ manager: options.memoryManager }),
          createMemoryWriteTool({ manager: options.memoryManager }),
        ]
      : []),
  ];
}

export { createReadTool } from './file/index.js';
export { createWriteTool } from './file/index.js';
export { createGrepTool } from './search/grep.js';
export { createGlobTool } from './search/glob.js';
export { createNotebookEditTool } from './notebook/notebookEdit.js';
export { createAskUserQuestionTool } from './system/askUserQuestion.js';
export { createEnterPlanModeTool } from './plan/enterPlanMode.js';
export { createExitPlanModeTool } from './plan/exitPlanMode.js';
export { createMemoryReadTool } from './memoryRead.js';
export { createMemoryWriteTool } from './memoryWrite.js';
export { createTodoWriteTool } from './todo/index.js';
export { createListMcpResourcesTool, createReadMcpResourceTool } from './mcp-tools/index.js';
