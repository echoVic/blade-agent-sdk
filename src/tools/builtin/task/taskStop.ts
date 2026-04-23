import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolKind.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { ToolErrorType } from '../../types/index.js';
import { AgentId, type SessionId } from '../../../types/branded.js';
import { TaskStore } from './TaskStore.js';

export function createTaskStopTool({ sessionId }: { sessionId: SessionId }) {
  return createTool({
    name: 'TaskStop',
    displayName: 'Stop Task',
    kind: ToolKind.Write,
    description: {
      short: 'Stop a running background task',
      long: 'Use this tool to stop a running background task (spawned via the Agent tool with run_in_background=true). This marks the task as completed and records the stop time.',
    },
    schema: lazySchema(() => z.object({
      taskId: z.string().describe('The ID of the background task to stop'),
    })),
    execute: async ({ taskId }, context) => {
      const agentManager = context.backgroundAgentManager;
      const aid = AgentId(taskId);
      if (agentManager?.getAgent(aid)) {
        const stopped = agentManager.killAgent(aid);
        const latestSession = agentManager.getAgent(aid);
        return {
          success: true,
          llmContent: latestSession ?? { taskId, status: stopped ? 'cancelled' : 'completed' },
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
          success: false,
          llmContent: `Task #${taskId} not found`,
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
        success: true,
        llmContent: updated ?? { taskId, status: 'completed' },
        metadata: {
          summary: `停止任务: ${taskId}`,
          task: updated,
        },
      };
    },
  });
}
