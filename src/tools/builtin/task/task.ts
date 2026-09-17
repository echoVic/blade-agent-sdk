import { nanoid } from 'nanoid';
import Type from 'typebox';
import type { BladeConfig } from '../../../agent/config.js';
import { SubagentExecutor } from '../../../agent/subagents/SubagentExecutor.js';
import type { SubagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import type {
  SubagentConfig,
  SubagentContext,
  SubagentResult,
} from '../../../agent/subagents/types.js';
import type { IBackgroundAgentManager } from '../../../agent/types.js';
import { isExecutionLeaseFailure } from '../../../session/events/DurableExecutionLeaseStore.js';
import { AgentId } from '../../../types/identifiers.js';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { type ExecutionContext, getRuntimeAccess } from '../../types/execution.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';

export const taskTool = createTool({
  name: 'Task',
  group: 'task',
  displayName: 'Subagent Scheduler',
  kind: ToolKind.ReadOnly,
  sideEffect: 'non_idempotent',
  services: ['subagentRegistry', 'backgroundAgentManager'],
  requiresRuntime: true,
  isReadOnly: true,
  isConcurrencySafe: false,
  schema: Type.Object({
    subagent_type: Type.String({ description: 'Registered subagent type' }),
    description: Type.String({
      minLength: 3,
      maxLength: 100,
      description: 'Short task description',
    }),
    prompt: Type.String({ minLength: 10, description: 'Detailed task instructions' }),
    run_in_background: ToolSchemas.flag({
      defaultValue: false,
      description: 'Run asynchronously and retrieve the result with TaskOutput',
    }),
    resume: Type.Optional(Type.String({ description: 'Agent ID to resume' })),
    subagent_session_id: Type.Optional(Type.String({ description: 'Explicit agent session ID' })),
  }),
  description: {
    short: 'Launch a specialized agent for complex multi-step work',
    long: 'Select a registered subagent, provide a self-contained prompt, and run it in the foreground or background. Background results are retrieved with TaskOutput.',
    usageNotes: [
      'Use direct tools for known files or focused searches',
      'Specify whether the agent should research or modify code',
      'Launch independent agents concurrently when useful',
    ],
  },
  async *execute(params, context) {
    const runtime = getRuntimeAccess(context);
    const registry = context.subagentRegistry;
    const manager = context.backgroundAgentManager;
    const config = registry.getSubagent(params.subagent_type);
    if (!config) {
      return failure(
        `Unknown subagent type: ${params.subagent_type}. Available types: ${registry.getAllNames().join(', ') || 'none'}`,
        `Unknown subagent type: ${params.subagent_type}`,
        '未知子 Agent 类型',
      );
    }
    const bladeConfig = context.bladeConfig;
    if (!bladeConfig) {
      return failure(
        'BladeConfig is required for subagent execution',
        'BladeConfig is required',
        '配置缺失',
      );
    }

    const agentId = AgentId(params.subagent_session_id || params.resume || nanoid());
    try {
      if (params.resume) {
        return await resumeAgent(
          AgentId(params.resume),
          params.prompt,
          params.description,
          config,
          bladeConfig,
          context,
          registry,
          manager,
        );
      }
      if (params.run_in_background) {
        const startedId = await manager.startBackgroundAgent({
          config,
          bladeConfig,
          subagentRegistry: registry,
          description: params.description,
          prompt: params.prompt,
          parentSessionId: context.sessionId,
          permissionMode: context.permissionMode,
          agentId,
          snapshot: context.contextSnapshot,
          executionFence: runtime.executionFence,
          assertExecutionLease: runtime.assertExecutionLease,
          runWithExecutionLease: runtime.runWithExecutionLease,
        });
        return runningResult(startedId, config.name, params.description);
      }

      yield {
        kind: 'message',
        content: { summary: `启动 ${params.subagent_type} subagent: ${params.description}` },
      };
      yield {
        kind: 'progress',
        message: '执行任务中...',
        data: { subagentType: params.subagent_type },
      };
      const executor = new SubagentExecutor(config, bladeConfig, registry, manager);
      const subagentContext: SubagentContext = {
        prompt: params.prompt,
        parentSessionId: context.sessionId,
        permissionMode: context.permissionMode,
        subagentSessionId: agentId,
        snapshot: context.contextSnapshot,
        signal: context.signal,
        executionFence: runtime.executionFence,
        assertExecutionLease: runtime.assertExecutionLease,
        runWithExecutionLease: runtime.runWithExecutionLease,
      };
      const started = Date.now();
      const result = await executor.execute(subagentContext);
      return foregroundResult(
        result,
        config.name,
        params.description,
        Date.now() - started,
        agentId,
      );
    } catch (error) {
      if (isExecutionLeaseFailure(error)) throw error;
      context.signal?.throwIfAborted();
      return failure(
        `Subagent execution error: ${getErrorMessage(error)}`,
        getErrorMessage(error),
        '子 Agent 执行失败',
        error,
      );
    }
  },
  preparePermissionMatcher: ({ subagent_type, description }) => ({
    signatureContent: `${subagent_type}:${description}`,
    abstractRule: '',
  }),
});

async function resumeAgent(
  agentId: AgentId,
  prompt: string,
  description: string,
  config: SubagentConfig,
  bladeConfig: BladeConfig,
  context: ExecutionContext,
  registry: SubagentRegistry,
  manager: IBackgroundAgentManager,
): Promise<ToolResult> {
  const session = await manager.getAgent(agentId);
  if (!session) {
    return failure(
      `Cannot resume agent ${agentId}: session not found`,
      `Agent session not found: ${agentId}`,
      '子 Agent 执行失败',
    );
  }
  if (manager.isRunning(agentId)) {
    return failure(
      `Cannot resume agent ${agentId}: still running`,
      `Agent is still running: ${agentId}`,
      '子 Agent 执行失败',
    );
  }
  const runtime = getRuntimeAccess(context);
  const resumedId = await manager.resumeAgent(
    agentId,
    prompt,
    config,
    bladeConfig,
    context.sessionId,
    context.permissionMode,
    registry,
    description,
    runtime.executionFence,
    runtime.assertExecutionLease,
    runtime.runWithExecutionLease,
  );
  if (!resumedId) {
    return failure(
      `Failed to resume agent ${agentId}`,
      `Failed to resume agent: ${agentId}`,
      '子 Agent 执行失败',
    );
  }
  return {
    ...runningResult(resumedId, config.name, description),
    model: {
      agent_id: resumedId,
      status: 'running',
      resumed_from: agentId,
      message: `Agent resumed in background. Use TaskOutput(task_id: "${resumedId}") to retrieve results.`,
    },
    metadata: {
      ...runningResult(resumedId, config.name, description).metadata,
      summary: '子 Agent 恢复完成',
      resumed_from: agentId,
    },
  };
}

function foregroundResult(
  result: SubagentResult,
  subagentType: string,
  description: string,
  duration: number,
  agentId: AgentId,
): ToolResult {
  return result.success
    ? {
        status: 'success',
        model: result.message,
        metadata: {
          summary: '子 Agent 执行完成',
          subagent_type: subagentType,
          description,
          duration,
          stats: result.stats,
          subagentSessionId: agentId,
          subagentType,
          subagentStatus: 'completed',
          subagentSummary: result.message.slice(0, 500),
        },
      }
    : {
        ...failure(
          `Subagent execution failed: ${result.error}`,
          result.error || 'Unknown error',
          '子 Agent 执行失败',
        ),
        metadata: {
          summary: '子 Agent 执行失败',
          subagentSessionId: agentId,
          subagentType,
          subagentStatus: 'failed',
        },
      };
}

function runningResult(agentId: string, type: string, description: string): ToolResult {
  return {
    status: 'success',
    model: {
      agent_id: agentId,
      status: 'running',
      message: `Agent started in background. Use TaskOutput(task_id: "${agentId}") to retrieve results.`,
    },
    metadata: {
      summary: '后台 Agent 已启动',
      agent_id: agentId,
      subagent_type: type,
      description,
      background: true,
      subagentSessionId: agentId,
      subagentType: type,
      subagentStatus: 'running',
    },
  };
}

function failure(model: string, message: string, summary: string, details?: unknown): ToolResult {
  return {
    status: 'error',
    model,
    error: { type: ToolErrorType.EXECUTION_ERROR, message, details },
    metadata: { summary },
  };
}
