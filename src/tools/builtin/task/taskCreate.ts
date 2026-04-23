import { z } from 'zod';
import { JsonValueSchema } from '../../../hooks/schemas/HookSchemas.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolKind.js';
import { lazySchema } from '../../validation/lazySchema.js';
import type { SessionId } from '../../../types/branded.js';
import type { CreateTaskInput } from './TaskStore.js';
import { TaskStore } from './TaskStore.js';

export function createTaskCreateTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskCreate',
    displayName: 'Create Task',
    kind: ToolKind.Write,
    description: {
      short: 'Create a new task in the task list',
      long: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

Use this tool proactively when:
- Complex multi-step tasks require 3 or more distinct steps
- Non-trivial tasks require careful planning or multiple operations
- The user provides multiple tasks to be done

All tasks are created with status \`pending\`.`,
    },
    schema: lazySchema(() => z.object({
      subject: z.string().describe('A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")'),
      description: z.string().describe('What needs to be done'),
      activeForm: z.string().optional().describe('Present continuous form shown in spinner when in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.'),
      metadata: z.record(z.string(), JsonValueSchema).optional().describe('Arbitrary metadata to attach to the task'),
    })),
    execute: async (input, context) => {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);
      const task = await store.create(input as unknown as CreateTaskInput);
      return {
        success: true,
        llmContent: { taskId: task.id, task },
        metadata: {
          summary: `创建任务: ${input.subject}`,
          task,
        },
      };
    },
  });
}
