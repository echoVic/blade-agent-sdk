import { z } from 'zod';
import { AgentId, type SessionId } from '../../../types/identifiers.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/kind.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { TaskStore } from './TaskStore.js';

export function createTaskStopTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskStop',
    displayName: 'Stop Task',
    kind: ToolKind.Write,
    sideEffect: 'idempotent',
    description: {
      short: 'Stop a running background task',
      long: 'Use this tool to stop a running background task (spawned via the Agent tool with run_in_background=true). This marks the task as completed and records the stop time.',
    },
    schema: lazySchema(() =>
      z.object({
        taskId: z.string().describe('The ID of the background task to stop'),
      }),
    ),
    // biome-ignore lint/correctness/useYield: terminal-only tool execution
    async *execute({ taskId }, context) {
      const agentManager = context.backgroundAgentManager;
      const aid = AgentId(taskId);
      if (agentManager?.getAgent(aid)) {
        const stopped = await agentManager.killAgent(aid);
        const latestSession = agentManager.getAgent(aid);
        if (!stopped && latestSession?.status === 'running') {
          return {
            status: 'error',
            model: `Background agent ${taskId} could not be stopped`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: `Background agent ${taskId} is owned by another execution`,
            },
            metadata: {
              summary: '无法停止后台 Agent',
              task: latestSession,
              stoppedBackgroundAgent: false,
            },
          };
        }
        return {
          status: 'success',
          model: toJsonValue(
            latestSession ?? { taskId, status: stopped ? 'cancelled' : 'completed' },
          ),
          metadata: {
            summary: `停止后台 Agent: ${taskId}`,
            task: latestSession,
            stoppedBackgroundAgent: true,
          },
        };
      }

      const sid = context?.sessionId ?? sessionId;
      const store = TaskStore.getInstance(sid);
      const task = await store.get(taskId);
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
      const updated = await store.update(taskId, {
        status: 'completed',
        metadata: { stoppedAt: new Date().toISOString() },
      });
      return {
        status: 'success',
        model: toJsonValue(updated ?? { taskId, status: 'completed' }),
        metadata: {
          summary: `停止任务: ${taskId}`,
          task: updated,
        },
      };
    },
  });
}
