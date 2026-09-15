import Type from 'typebox';
import type { Memory } from '../../../memory/types.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';

const memoryReadSchema = Type.Union([
  Type.Object({
    operation: Type.Literal('list', { description: 'List all memories' }),
  }),
  Type.Object({
    operation: Type.Literal('get', { description: 'Get a specific memory by name' }),
    name: Type.String({ description: 'Memory name' }),
  }),
  Type.Object({
    operation: Type.Literal('search', { description: 'Search memories by query' }),
    query: Type.String({ description: 'Search query' }),
  }),
  Type.Object({
    operation: Type.Literal('index', { description: 'Read the derived memory index content' }),
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

export const memoryReadTool = createTool({
  name: 'MemoryRead',
  displayName: 'Read Memory',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  services: ['memoryManager'],
  description: {
    short: 'Read memories from the configured memory store',
    long: `Read memories from the configured memory store supplied by the SDK consumer.

Operations:
- list: List all memories (returns summaries)
- get: Get a specific memory by name
- search: Search memories by query (returns summaries; case-insensitive substring match on name, description, body)
- index: Read the derived memory index content`,
  },
  schema: lazySchema(() => memoryReadSchema),
  // biome-ignore lint/correctness/useYield: terminal-only tool execution
  async *execute(params, context) {
    const manager = context.memoryManager;
    switch (params.operation) {
      case 'list': {
        const summaries = (await manager.list()).map(toMemorySummary);
        return {
          status: 'success',
          model: toJsonValue(summaries),
          metadata: {
            summary: summaries.length === 0 ? '记忆列表为空' : `列出 ${summaries.length} 条记忆`,
          },
        };
      }
      case 'get': {
        const memory = await manager.get(params.name);
        if (!memory) {
          return {
            status: 'error',
            model: `Memory "${params.name}" not found`,
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
          status: 'success',
          model: toJsonValue(memory),
          metadata: {
            summary: `读取记忆: ${params.name}`,
          },
        };
      }
      case 'search': {
        const summaries = (await manager.search(params.query)).map(toMemorySummary);
        return {
          status: 'success',
          model: toJsonValue(summaries),
          metadata: {
            summary: `搜索记忆: ${summaries.length} 条结果`,
          },
        };
      }
      case 'index': {
        const content = await manager.readIndexContent();
        return {
          status: 'success',
          model: content,
          metadata: {
            summary: '读取所有记忆',
          },
        };
      }
    }
  },
});
