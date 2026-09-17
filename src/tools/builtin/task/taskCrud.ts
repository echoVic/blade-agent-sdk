import Type from 'typebox';
import type { JsonValue } from '../../../types/json.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext } from '../../types/execution.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { requireSessionId } from '../sessionContext.js';
import { TaskStore } from './TaskStore.js';

const taskIdSchema = Type.String({ description: 'Task identifier' });
const metadataSchema = Type.Record(Type.String(), Type.Unsafe<JsonValue>({}));

const storeFor = (context: ExecutionContext) => TaskStore.getInstance(requireSessionId(context));

function notFound(taskId: string): ToolResult {
  return {
    status: 'error',
    model: `Task #${taskId} not found`,
    error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
    metadata: { summary: '未找到任务' },
  };
}

export const taskCreateTool = createTool({
  name: 'TaskCreate',
  group: 'task',
  displayName: 'Create Task',
  kind: ToolKind.Write,
  sideEffect: 'non_idempotent',
  description: {
    short: 'Create a structured task for the current session',
    long: 'Use for multi-step work that benefits from explicit progress tracking. New tasks start pending.',
  },
  schema: Type.Object({
    subject: Type.String({ description: 'Brief actionable title' }),
    description: Type.String({ description: 'What needs to be done' }),
    activeForm: Type.Optional(Type.String({ description: 'Present-continuous progress label' })),
    metadata: Type.Optional(metadataSchema),
  }),
  // biome-ignore lint/correctness/useYield: terminal-only tool execution
  async *execute(input, context) {
    const task = await storeFor(context).create(input);
    return {
      status: 'success',
      model: toJsonValue({ taskId: task.id, task }),
      metadata: { summary: `创建任务: ${input.subject}`, task },
    };
  },
});

export const taskGetTool = createTool({
  name: 'TaskGet',
  group: 'task',
  displayName: 'Get Task',
  kind: ToolKind.Write,
  sideEffect: 'pure',
  description: { short: 'Retrieve a task by ID' },
  schema: Type.Object({ taskId: taskIdSchema }),
  // biome-ignore lint/correctness/useYield: terminal-only tool execution
  async *execute({ taskId }, context) {
    const task = await storeFor(context).get(taskId);
    return task
      ? {
          status: 'success',
          model: toJsonValue(task),
          metadata: { summary: `获取任务: ${taskId}`, task },
        }
      : notFound(taskId);
  },
});

export const taskListTool = createTool({
  name: 'TaskList',
  group: 'task',
  displayName: 'List Tasks',
  kind: ToolKind.Write,
  sideEffect: 'pure',
  description: { short: 'List task status and dependencies for the current session' },
  schema: Type.Object({}),
  async *execute(_input, context) {
    const tasks = await storeFor(context).list();
    const summary = tasks.map(({ id, subject, status, owner = '', blockedBy }) => ({
      id,
      subject,
      status,
      owner,
      blockedBy,
    }));
    return {
      status: 'success',
      model: summary,
      metadata: { summary: `列出 ${tasks.length} 个任务`, tasks: summary },
    };
  },
});

export const taskUpdateTool = createTool({
  name: 'TaskUpdate',
  group: 'task',
  displayName: 'Update Task',
  kind: ToolKind.Write,
  sideEffect: 'idempotent',
  description: {
    short: 'Update task details, status, or dependencies',
    long: 'Status normally moves pending → in_progress → completed. Use deleted to remove a task.',
  },
  schema: Type.Object({
    taskId: taskIdSchema,
    status: Type.Optional(Type.Enum(['pending', 'in_progress', 'completed', 'deleted'])),
    subject: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    activeForm: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    metadata: Type.Optional(metadataSchema),
    addBlocks: Type.Optional(Type.Array(taskIdSchema)),
    addBlockedBy: Type.Optional(Type.Array(taskIdSchema)),
  }),
  // biome-ignore lint/correctness/useYield: terminal-only tool execution
  async *execute({ taskId, ...input }, context) {
    const store = storeFor(context);
    if (input.status === 'deleted') {
      if (!(await store.get(taskId))) return notFound(taskId);
      await store.delete(taskId);
      return {
        status: 'success',
        model: toJsonValue({ taskId, deleted: true }),
        metadata: { summary: `删除任务: ${taskId}` },
      };
    }
    const task = await store.update(taskId, input);
    return task
      ? {
          status: 'success',
          model: toJsonValue(task),
          metadata: { summary: `更新任务: ${taskId}`, task },
        }
      : notFound(taskId);
  },
});
