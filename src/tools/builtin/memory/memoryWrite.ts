import Type from 'typebox';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
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

export const memoryWriteTool = createTool({
  name: 'MemoryWrite',
  displayName: 'Write Memory',
  kind: ToolKind.Write,
  sideEffect: 'idempotent',
  services: ['memoryManager'],
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
  async *execute(params, context) {
    const manager = context.memoryManager;
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
  },
});
