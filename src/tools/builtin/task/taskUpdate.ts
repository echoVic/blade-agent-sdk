import Type from 'typebox';
import type { SessionId } from '../../../types/identifiers.js';
import type { JsonValue } from '../../../types/json.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { TaskStore } from './TaskStore.js';

export function createTaskUpdateTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskUpdate',
    displayName: 'Update Task',
    kind: ToolKind.Write,
    sideEffect: 'idempotent',
    description: {
      short: 'Update a task in the task list',
      long: `Use this tool to update a task's status, details, or dependencies.

Status workflow: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

ONLY mark a task as completed when you have FULLY accomplished it.`,
    },
    schema: lazySchema(() =>
      Type.Object({
        taskId: Type.String({ description: 'The ID of the task to update' }),
        status: Type.Optional(Type.Enum(['pending', 'in_progress', 'completed', 'deleted'])),
        subject: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        activeForm: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
        metadata: Type.Optional(
          Type.Record(Type.String(), Type.Unsafe<JsonValue>({}), {
            description: 'Metadata keys to merge into the task. Set a key to null to delete it.',
          }),
        ),
        addBlocks: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Task IDs that this task blocks',
          }),
        ),
        addBlockedBy: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Task IDs that must complete before this one can start',
          }),
        ),
      }),
    ),
    // biome-ignore lint/correctness/useYield: terminal-only tool execution
    async *execute({ taskId, ...input }, context) {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);

      if (input.status === 'deleted') {
        const existing = await store.get(taskId);
        if (!existing) {
          return {
            status: 'error',
            model: `Task #${taskId} not found`,
            error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
            metadata: {
              summary: '未找到任务',
            },
          };
        }
        await store.delete(taskId);
        return {
          status: 'success',
          model: toJsonValue({ taskId, deleted: true }),
          metadata: {
            summary: `删除任务: ${taskId}`,
          },
        };
      }

      const task = await store.update(taskId, input);
      if (!task) {
        return {
          status: 'error',
          model: `Task #${taskId} not found`,
          error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
          metadata: {
            summary: '未找到任务',
          },
        };
      }
      return {
        status: 'success',
        model: toJsonValue(task),
        metadata: {
          summary: `更新任务: ${taskId}`,
          task,
        },
      };
    },
  });
}
