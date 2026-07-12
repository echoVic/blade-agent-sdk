import type { Tool } from '../tools/types/index.js';
import { readTool, writeTool } from './file/index.js';
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
    readTool,
    writeTool,
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
export { createMemoryReadTool } from './memoryRead.js';
export { createMemoryWriteTool } from './memoryWrite.js';
