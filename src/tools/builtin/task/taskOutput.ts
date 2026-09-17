import { setTimeout as delay } from 'node:timers/promises';
import Type from 'typebox';
import type { IBackgroundAgentManager } from '../../../agent/types.js';
import { AgentId } from '../../../types/identifiers.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { BackgroundShellManager } from '../shell/BackgroundShellManager.js';

export const taskOutputTool = createTool({
  name: 'TaskOutput',
  group: 'task',
  displayName: 'Task Output',
  kind: ToolKind.ReadOnly,
  sideEffect: 'non_idempotent',
  services: ['backgroundAgentManager'],
  schema: Type.Object({
    task_id: Type.String({ minLength: 1, description: 'Background task ID' }),
    block: ToolSchemas.flag({ defaultValue: true, description: 'Wait for completion' }),
    timeout: Type.Integer({
      minimum: 0,
      maximum: 600_000,
      default: 30_000,
      description: 'Maximum wait in milliseconds',
    }),
  }),
  description: {
    short: 'Read output from a background shell or agent',
    usageNotes: [
      'Use the ID returned by Bash or Task',
      'Set block=false to return the current state immediately',
    ],
  },
  // biome-ignore lint/correctness/useYield: terminal-only tool execution
  async *execute({ task_id: taskId, block, timeout }, context) {
    const shells = BackgroundShellManager.getInstance();
    if (taskId.startsWith('bash_') || shells.getProcess(taskId)) {
      return shellOutput(taskId, block, timeout, shells);
    }
    const agentId = AgentId(taskId);
    if (await context.backgroundAgentManager.getAgent(agentId)) {
      return agentOutput(agentId, block, timeout, context.backgroundAgentManager);
    }
    return failure(
      `Unknown task ID: ${taskId}.`,
      `Unknown task ID: ${taskId}`,
      '未找到任务',
      ToolErrorType.VALIDATION_ERROR,
    );
  },
  preparePermissionMatcher: ({ task_id }) => ({
    signatureContent: task_id,
    abstractRule: '*',
  }),
});

async function shellOutput(
  taskId: string,
  block: boolean,
  timeout: number,
  manager: BackgroundShellManager,
): Promise<ToolResult> {
  let process = manager.getProcess(taskId);
  if (!process) {
    return failure(`Shell not found: ${taskId}`, 'Shell 会话不存在或已清理');
  }
  if (block && process.status === 'running') {
    const deadline = Date.now() + timeout;
    while (process?.status === 'running' && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
      process = manager.getProcess(taskId);
    }
  }
  const snapshot = manager.consumeOutput(taskId);
  if (!snapshot) {
    return failure(`Failed to get output for shell: ${taskId}`, 'Failed to consume output');
  }
  const payload = {
    task_id: snapshot.id,
    type: 'shell',
    status: snapshot.status,
    command: snapshot.command,
    pid: snapshot.pid,
    exit_code: snapshot.exitCode,
    signal: snapshot.signal,
    started_at: new Date(snapshot.startedAt).toISOString(),
    finished_at: snapshot.endedAt ? new Date(snapshot.endedAt).toISOString() : undefined,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
  };
  return success(taskId, payload);
}

async function agentOutput(
  taskId: AgentId,
  block: boolean,
  timeout: number,
  manager: IBackgroundAgentManager,
): Promise<ToolResult> {
  let session = await manager.getAgent(taskId);
  if (!session) return failure(`Agent not found: ${taskId}`, 'Agent 会话不存在或已清理');
  if (block && session.status === 'running') {
    session = await manager.waitForCompletion(taskId, timeout);
    if (!session) {
      return failure(`Failed to wait for agent: ${taskId}`, 'Wait for completion failed');
    }
  }
  const payload = {
    task_id: session.id,
    type: 'agent',
    status: session.status,
    subagent_type: session.subagentType,
    description: session.description,
    created_at: new Date(session.createdAt).toISOString(),
    last_active_at: new Date(session.lastActiveAt).toISOString(),
    completed_at: session.completedAt ? new Date(session.completedAt).toISOString() : undefined,
    result: session.result,
    stats: session.stats,
    progress: session.progress,
  };
  const status =
    session.status === 'completed'
      ? 'completed'
      : session.status === 'failed'
        ? 'failed'
        : 'running';
  return {
    ...success(taskId, payload),
    metadata: {
      summary: `获取任务输出: ${taskId}`,
      ...payload,
      subagentSessionId: session.id,
      subagentType: session.subagentType,
      subagentStatus: status,
      subagentSummary:
        typeof session.result?.message === 'string'
          ? session.result.message.slice(0, 500)
          : undefined,
    },
  };
}

function success(taskId: string, payload: object): ToolResult {
  return {
    status: 'success',
    model: toJsonValue(payload),
    metadata: { summary: `获取任务输出: ${taskId}`, ...payload },
  };
}

function failure(
  model: string,
  message: string,
  summary = '获取输出失败',
  type = ToolErrorType.EXECUTION_ERROR,
): ToolResult {
  return {
    status: 'error',
    model,
    error: { type, message },
    metadata: { summary },
  };
}
