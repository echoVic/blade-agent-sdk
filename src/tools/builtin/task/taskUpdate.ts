import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolTypes.js';
import { ToolErrorType } from '../../types/index.js';
import { TaskStore } from './TaskStore.js';

export function createTaskUpdateTool({ sessionId }: { sessionId: string }) {
  return createTool({
    name: 'TaskUpdate',
    displayName: 'Update Task',
    kind: ToolKind.Write,
    description: {
      short: 'Update a task in the task list',
      long: `Use this tool to update a task's status, details, or dependencies.

Status workflow: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

ONLY mark a task as completed when you have FULLY accomplished it.`,
    },
    schema: z.object({
      taskId: z.string().describe('The ID of the task to update'),
      status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      owner: z.string().optional(),
      metadata: z.record(z.unknown()).optional().describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
      addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
      addBlockedBy: z.array(z.string()).optional().describe('Task IDs that must complete before this one can start'),
    }),
    execute: async ({ taskId, ...input }, context) => {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);

      if (input.status === 'deleted') {
        const existing = await store.get(taskId);
        if (!existing) {
          return {
            success: false,
            llmContent: `Task #${taskId} not found`,
            displayContent: `Task #${taskId} not found`,
            error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
          };
        }
        await store.delete(taskId);
        return {
          success: true,
          llmContent: { taskId, deleted: true },
          displayContent: `Task #${taskId} deleted`,
        };
      }

      const task = await store.update(taskId, input);
      if (!task) {
        return {
          success: false,
          llmContent: `Task #${taskId} not found`,
          displayContent: `Task #${taskId} not found`,
          error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
        };
      }
      return {
        success: true,
        llmContent: task,
        displayContent: `Task #${task.id} updated: ${task.subject} [${task.status}]`,
        metadata: { task },
      };
    },
  });
}
