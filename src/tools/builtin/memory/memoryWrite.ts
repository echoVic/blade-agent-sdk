import { z } from 'zod';
import type { MemoryManager } from '../../../memory/MemoryManager.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

const memoryWriteSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('save').describe('Create or update a memory'),
    name: z.string().describe('Memory name (unique identifier)'),
    description: z.string().describe('One-line description'),
    type: z.enum(['user', 'feedback', 'project', 'reference']).describe('Memory type'),
    body: z.string().describe('Memory body content'),
  }),
  z.object({
    operation: z.literal('delete').describe('Request deletion of a memory'),
    name: z.string().describe('Memory name (unique identifier)'),
  }),
]);

export function createMemoryWriteTool({ manager }: { manager: MemoryManager }) {
  return createTool({
    name: 'MemoryWrite',
    displayName: 'Write Memory',
    kind: ToolKind.Write,
    description: {
      short: 'Save or delete memories in the configured memory store',
      long: `Save or delete memories in the configured memory store supplied by the SDK consumer.

Operations:
- save: Create or update a memory (upsert by name)
- delete: Request deletion of a memory by name

Memory types: user, feedback, project, reference`,
    },
    schema: memoryWriteSchema,
    execute: async (params) => {
      switch (params.operation) {
        case 'save': {
          const memory = await manager.save({
            name: params.name,
            description: params.description,
            type: params.type,
            body: params.body,
          });
          return {
            success: true,
            llmContent: memory,
            metadata: {
              summary: `保存记忆: ${params.name}`,
            },
          };
        }
        case 'delete': {
          await manager.delete(params.name);
          return {
            success: true,
            llmContent: { name: params.name, deleteRequested: true },
            metadata: {
              summary: `删除记忆: ${params.name}`,
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
