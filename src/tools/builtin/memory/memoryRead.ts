import { z } from 'zod';
import type { Memory } from '../../../memory/MemoryTypes.js';
import type { MemoryManager } from '../../../memory/MemoryManager.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType } from '../../types/ToolResult.js';
import { ToolKind } from '../../types/ToolKind.js';

const memoryReadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('list').describe('List all memories'),
  }),
  z.object({
    operation: z.literal('get').describe('Get a specific memory by name'),
    name: z.string().describe('Memory name'),
  }),
  z.object({
    operation: z.literal('search').describe('Search memories by query'),
    query: z.string().describe('Search query'),
  }),
  z.object({
    operation: z.literal('index').describe('Read the derived memory index content'),
  }),
]);

function toMemorySummary(memory: Memory) {
  return {
    name: memory.name,
    description: memory.description,
    type: memory.type,
    updatedAt: memory.updatedAt,
  };
}

export function createMemoryReadTool({ manager }: { manager: MemoryManager }) {
  return createTool({
    name: 'MemoryRead',
    displayName: 'Read Memory',
    kind: ToolKind.ReadOnly,
    description: {
      short: 'Read memories from the configured memory store',
      long: `Read memories from the configured memory store supplied by the SDK consumer.

Operations:
- list: List all memories (returns summaries)
- get: Get a specific memory by name
- search: Search memories by query (returns summaries; case-insensitive substring match on name, description, body)
- index: Read the derived memory index content`,
    },
    schema: memoryReadSchema,
    execute: async (params) => {
      switch (params.operation) {
        case 'list': {
          const summaries = (await manager.list()).map(toMemorySummary);
          return {
            success: true,
            llmContent: summaries,
            metadata: {
              summary: summaries.length === 0
                ? '记忆列表为空'
                : `列出 ${summaries.length} 条记忆`,
            },
          };
        }
        case 'get': {
          const memory = await manager.get(params.name);
          if (!memory) {
            return {
              success: false,
              llmContent: `Memory "${params.name}" not found`,
              error: {
                type: ToolErrorType.EXECUTION_ERROR,
                message: `Memory "${params.name}" not found`,
              },
              metadata: {
                summary: `未找到记忆: ${params.name}`,
              },
            };
          }
          return {
            success: true,
            llmContent: memory,
            metadata: {
              summary: `读取记忆: ${params.name}`,
            },
          };
        }
        case 'search': {
          const summaries = (await manager.search(params.query)).map(toMemorySummary);
          return {
            success: true,
            llmContent: summaries,
            metadata: {
              summary: `搜索记忆: ${summaries.length} 条结果`,
            },
          };
        }
        case 'index': {
          const content = await manager.readIndexContent();
          return {
            success: true,
            llmContent: content,
            metadata: {
              summary: '读取所有记忆',
            },
          };
        }
      }

      return {
        success: false,
        llmContent: `Unsupported operation: ${(params as { operation: string }).operation}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: `Unsupported operation: ${(params as { operation: string }).operation}`,
        },
        metadata: {
          summary: '不支持的操作',
        },
      };
    },
  });
}
