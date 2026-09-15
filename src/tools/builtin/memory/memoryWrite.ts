import Type from 'typebox';
import type { MemoryManager } from '../../../memory/MemoryManager.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/kind.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';

const memoryWriteSchema = Type.Union([
  Type.Object({
    operation: Type.Literal('save', { description: 'Create or update a memory' }),
    name: Type.String({ description: 'Memory name (unique identifier)' }),
    description: Type.String({ description: 'One-line description' }),
    type: Type.Enum(['user', 'feedback', 'project', 'reference'], {
      description: 'Memory type',
    }),
    body: Type.String({ description: 'Memory body content' }),
  }),
  Type.Object({
    operation: Type.Literal('delete', { description: 'Request deletion of a memory' }),
    name: Type.String({ description: 'Memory name (unique identifier)' }),
  }),
]);

export function createMemoryWriteTool({ manager }: { manager: MemoryManager }) {
  return createTool({
    name: 'MemoryWrite',
    displayName: 'Write Memory',
    kind: ToolKind.Write,
    sideEffect: 'idempotent',
    description: {
      short: 'Save or delete memories in the configured memory store',
      long: `Save or delete memories in the configured memory store supplied by the SDK consumer.

Operations:
- save: Create or update a memory (upsert by name)
- delete: Request deletion of a memory by name

Memory types: user, feedback, project, reference`,
    },
    schema: lazySchema(() => memoryWriteSchema),
    // biome-ignore lint/correctness/useYield: terminal-only tool execution
    async *execute(params) {
      switch (params.operation) {
        case 'save': {
          const memory = await manager.save({
            name: params.name,
            description: params.description,
            type: params.type,
            body: params.body,
          });
          return {
            status: 'success',
            model: toJsonValue(memory),
            metadata: {
              summary: `保存记忆: ${params.name}`,
            },
          };
        }
        case 'delete': {
          await manager.delete(params.name);
          return {
            status: 'success',
            model: { name: params.name, deleteRequested: true },
            metadata: {
              summary: `删除记忆: ${params.name}`,
            },
          };
        }
      }

      return {
        status: 'error',
        model: `Unsupported operation: ${(params as { operation: string }).operation}`,
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
