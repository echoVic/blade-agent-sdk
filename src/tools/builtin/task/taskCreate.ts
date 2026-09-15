import Type from 'typebox';
import type { SessionId } from '../../../types/identifiers.js';
import type { JsonValue } from '../../../types/json.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { TaskStore } from './TaskStore.js';

export function createTaskCreateTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskCreate',
    displayName: 'Create Task',
    kind: ToolKind.Write,
    sideEffect: 'non_idempotent',
    description: {
      short: 'Create a new task in the task list',
      long: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

Use this tool proactively when:
- Complex multi-step tasks require 3 or more distinct steps
- Non-trivial tasks require careful planning or multiple operations
- The user provides multiple tasks to be done

All tasks are created with status \`pending\`.`,
    },
    schema: lazySchema(() =>
      Type.Object({
        subject: Type.String({
          description:
            'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")',
        }),
        description: Type.String({ description: 'What needs to be done' }),
        activeForm: Type.Optional(
          Type.String({
            description:
              'Present continuous form shown in spinner when in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.',
          }),
        ),
        metadata: Type.Optional(
          Type.Record(Type.String(), Type.Unsafe<JsonValue>({}), {
            description: 'Arbitrary metadata to attach to the task',
          }),
        ),
      }),
    ),
    // biome-ignore lint/correctness/useYield: terminal-only tool execution
    async *execute(input, context) {
      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);
      const task = await store.create(input);
      return {
        status: 'success',
        model: toJsonValue({ taskId: task.id, task }),
        metadata: {
          summary: `创建任务: ${input.subject}`,
          task,
        },
      };
    },
  });
}
