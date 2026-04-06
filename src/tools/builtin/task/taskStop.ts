import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../types/ToolTypes.js';
import { ToolErrorType } from '../../types/index.js';
import { TaskStore } from './TaskStore.js';

export function createTaskStopTool({ sessionId }: { sessionId: string }) {
  return createTool({
    name: 'TaskStop',
    displayName: 'Stop Task',
    kind: ToolKind.Write,
    description: {
      short: 'Stop a running background task',
      long: 'Use this tool to stop a running background task (spawned via the Agent tool with run_in_background=true). This marks the task as completed and records the stop time.',
    },
    schema: z.object({
      taskId: z.string().describe('The ID of the background task to stop'),
    }),
    execute: async ({ taskId }, context) => {
      const agentManager = context.backgroundAgentManager;
      if (agentManager?.getAgent(taskId)) {
        const stopped = agentManager.killAgent(taskId);
        const latestSession = agentManager.getAgent(taskId);
        return {
          success: true,
          llmContent: latestSession ?? { taskId, status: stopped ? 'cancelled' : 'completed' },
          displayContent: `Background agent #${taskId} stopped`,
          metadata: {
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
          displayContent: `Task #${taskId} not found`,
          error: { type: ToolErrorType.VALIDATION_ERROR, message: `Task ${taskId} not found` },
        };
      }
      const updated = await store.update(taskId, {
        status: 'completed',
        metadata: { stoppedAt: new Date().toISOString() },
      });
      return {
        success: true,
        llmContent: updated ?? { taskId, status: 'completed' },
        displayContent: `Task #${taskId} stopped`,
        metadata: { task: updated },
      };
    },
  });
}
