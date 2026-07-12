import type { Tool } from '../tools/types/index.js';
import { editTool, readTool, writeTool } from './file/index.js';
import { globTool, grepTool } from './search/index.js';
import type { MemoryManager } from './memory.js';
import { createMemoryReadTool } from './memoryRead.js';
import { createMemoryWriteTool } from './memoryWrite.js';

export interface BuiltinToolsOptions {
  memoryManager?: MemoryManager;
  sessionId?: unknown;
  configDir?: string;
  mcpRegistry?: unknown;
  includeMcpProtocolTools?: boolean;
  subagentRegistry?: unknown;
}

export async function getBuiltinTools(options: BuiltinToolsOptions = {}): Promise<Tool[]> {
  return [
    editTool,
    readTool,
    writeTool,
    grepTool,
    globTool,
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
export { createMemoryReadTool } from './memoryRead.js';
export { createMemoryWriteTool } from './memoryWrite.js';
