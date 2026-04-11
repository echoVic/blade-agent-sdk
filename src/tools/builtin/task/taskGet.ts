import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolTypes.js';
import { ToolErrorType } from '../../types/index.js';
import { TaskStore } from './TaskStore.js';

export function createTaskGetTool({ sessionId }: { sessionId: string }) {
  return createTool({
    name: 'TaskGet',
    displayName: 'Get Task',
    kind: ToolKind.Write,
    description: {
      short: 'Retrieve a task by its ID from the task list',
      long: `Use this tool to get full task details including description, status, dependencies, and metadata.

Use when:
- You need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements`,
    },
    schema: z.object({
      taskId: z.string().describe('The ID of the task to retrieve'),
    }),
    execute: async ({ taskId }, context) => {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);
      const task = await store.get(taskId);
      if (!task) {
        return {
          success: false,
          llmContent: `Task #${taskId} not found`,
          error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
          metadata: {
            summary: '未找到任务',
          },
        };
      }
      return {
        success: true,
        llmContent: task,
        metadata: {
          summary: `获取任务: ${taskId}`,
          task,
        },
      };
    },
  });
}
