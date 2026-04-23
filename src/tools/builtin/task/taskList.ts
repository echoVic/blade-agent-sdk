import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolKind.js';
import { lazySchema } from '../../validation/lazySchema.js';
import type { SessionId } from '../../../types/branded.js';
import { TaskStore } from './TaskStore.js';

export function createTaskListTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskList',
    displayName: 'List Tasks',
    kind: ToolKind.Write,
    description: {
      short: 'List all tasks in the task list',
      long: `Use this tool to see all tasks and their current status.

Returns a summary of each task:
- id: Task identifier
- subject: Brief description
- status: pending, in_progress, or completed
- owner: Agent ID if assigned, empty if available
- blockedBy: List of open task IDs that must be resolved first

Prefer working on tasks in ID order (lowest ID first) when multiple tasks are available.`,
    },
    schema: lazySchema(() => z.object({})),
    execute: async (_input, context) => {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);
      const tasks = await store.list();
      const summary = tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner ?? '',
        blockedBy: t.blockedBy,
      }));
      return {
        success: true,
        llmContent: summary,
        metadata: {
          summary: `列出 ${tasks.length} 个任务`,
          tasks: summary,
        },
      };
    },
  });
}
