import Type from 'typebox';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { requireSessionId } from '../sessionContext.js';
import { TaskStore } from './TaskStore.js';

export const taskListTool = createTool({
  name: 'TaskList',
  group: 'task',
  displayName: 'List Tasks',
  kind: ToolKind.Write,
  sideEffect: 'pure',
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
  schema: lazySchema(() => Type.Object({})),
  async *execute(_input, context) {
    const store = TaskStore.getInstance(requireSessionId(context));
    const tasks = await store.list();
    const summary = tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner ?? '',
      blockedBy: t.blockedBy,
    }));
    return {
      status: 'success',
      model: summary,
      metadata: {
        summary: `列出 ${tasks.length} 个任务`,
        tasks: summary,
      },
    };
  },
});
