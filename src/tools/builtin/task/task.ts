/**
 * Task Tool - Subagent 调度工具
 *
 * 1. Markdown + YAML frontmatter 配置 subagent
 * 2. 模型决策 - 让模型自己决定用哪个 subagent_type
 * 3. subagent_type 参数必需 - 明确指定要使用的 subagent
 * 4. 工具隔离 - 每个 subagent 配置自己的工具白名单
 * 5. 后台执行 - 支持 run_in_background 参数
 * 6. 会话恢复 - 支持 resume 参数
 */

import { nanoid } from 'nanoid';
import Type from 'typebox';
import { SubagentExecutor } from '../../../agent/subagents/SubagentExecutor.js';
import type { SubagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import type { SubagentContext, SubagentResult } from '../../../agent/subagents/types.js';
import type { IBackgroundAgentManager } from '../../../agent/types.js';
import { HookManager } from '../../../hooks/HookManager.js';
import { isHookProcessContainmentError } from '../../../hooks/WindowsProcessJob.js';
import { isExecutionLeaseFailure } from '../../../session/events/DurableExecutionLeaseStore.js';
import { PermissionMode } from '../../../types/constants.js';
import { AgentId, SessionId } from '../../../types/identifiers.js';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { type ExecutionContext, getRuntimeAccess } from '../../types/execution.js';
import type { ToolResult } from '../../types/result.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';

function getTaskDescription(): string {
  return `
## Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will need to use TaskOutput to retrieve its results once it's done. You can continue to work while background agents run - When you need their results to continue you can use TaskOutput in blocking mode to pause and wait for their results.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- When the agent is done, it will return a single message back to you along with its agent ID. You can use this ID to resume the agent later if needed for follow-up work.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Agents with "access to current context" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. The agent will receive all prior messages and understand the context.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a code-reviewer agent and a test-runner agent in parallel, send a single message with both tool calls.
  `.trim();
}

/**
 * TaskTool - Subagent 调度器
 *
 * 核心设计：
 * - subagent_type 参数（必需）- 明确指定使用哪个 subagent
 * - 模型从 subagent 描述中选择合适的类型
 * - 每个 subagent 有独立的系统提示和工具配置
 */
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
  schema: lazySchema(() =>
    Type.Object({
      subagent_type: Type.String({
        description: 'Subagent type to use (e.g., "Explore", "Plan")',
      }),
      description: Type.String({
        minLength: 3,
        maxLength: 100,
        description: 'Short task description (3-5 words)',
      }),
      prompt: Type.String({
        minLength: 10,
        description: 'Detailed task instructions',
      }),
      run_in_background: ToolSchemas.flag({
        defaultValue: false,
        description:
          'Set to true to run this agent in the background. Use TaskOutput to read the output later.',
      }),
      resume: Type.Optional(
        Type.String({
          description:
            'Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.',
        }),
      ),
      subagent_session_id: Type.Optional(
        Type.String({ description: 'Internal subagent session id for tracking' }),
      ),
    }),
  ),
  description: {
    short: 'Launch a new agent to handle complex, multi-step tasks autonomously',
    long: getTaskDescription(),
    usageNotes: [
      'subagent_type is required - choose from available agent types',
      'description should be 3-5 words (e.g., "Explore error handling")',
      'prompt should contain a highly detailed task description and specify exactly what information to return',
      'Launch multiple agents concurrently when possible for better performance',
    ],
    examples: [
      {
        description: 'Explore codebase for API endpoints',
        params: {
          subagent_type: 'Explore',
          description: 'Find API endpoints',
          prompt:
            'Search the codebase for all API endpoint definitions. Look for route handlers, REST endpoints, and GraphQL resolvers. Return a structured list with file paths, endpoint URLs, HTTP methods, and descriptions.',
        },
      },
      {
        description: 'Plan authentication feature',
        params: {
          subagent_type: 'Plan',
          description: 'Plan user auth',
          prompt:
            'Create a detailed implementation plan for adding user authentication to this project. Analyze the existing architecture, then provide step-by-step instructions including: 1) Database schema changes 2) API routes to create 3) Frontend components needed 4) Security considerations 5) Testing strategy. Be specific about file names and code locations.',
        },
      },
    ],
  },
  async *execute(params, context) {
    const runtime = getRuntimeAccess(context);
    const registry = context.subagentRegistry;
    const manager = context.backgroundAgentManager;
    const {
      subagent_type,
      description,
      prompt,
      run_in_background = false,
      resume,
      subagent_session_id,
    } = params;
    const subagentSessionId = AgentId(
      typeof subagent_session_id === 'string' && subagent_session_id.length > 0
        ? subagent_session_id
        : typeof resume === 'string' && resume.length > 0
          ? resume
          : nanoid(),
    );

    try {
      const registeredNames = registry.getAllNames();
      const subagentConfig = registry.getSubagent(subagent_type);
      if (!subagentConfig) {
        return {
          status: 'error',
          model: `Unknown subagent type: ${subagent_type}. Available types: ${registeredNames.join(', ') || 'none'}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Unknown subagent type: ${subagent_type}`,
          },
          metadata: {
            summary: '未知子 Agent 类型',
          },
        };
      }

      if (resume) {
        return await handleResume(
          AgentId(resume),
          prompt,
          subagentConfig,
          description,
          context,
          registry,
          manager,
        );
      }

      if (run_in_background) {
        return await handleBackgroundExecution(
          subagentConfig,
          description,
          prompt,
          context,
          subagentSessionId,
          registry,
          manager,
        );
      }

      yield {
        kind: 'message',
        content: { summary: `启动 ${subagent_type} subagent: ${description}` },
      };

      if (!context.bladeConfig) {
        return {
          status: 'error',
          model: 'BladeConfig is required for subagent execution',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'BladeConfig is required',
          },
          metadata: {
            summary: '配置缺失',
          },
        };
      }

      const executor = new SubagentExecutor(subagentConfig, context.bladeConfig, registry, manager);
      const subagentContext: SubagentContext = {
        prompt,
        parentSessionId: context.sessionId,
        permissionMode: context.permissionMode,
        subagentSessionId,
        snapshot: context.contextSnapshot,
        signal: context.signal,
        executionFence: runtime.executionFence,
        assertExecutionLease: runtime.assertExecutionLease,
        runWithExecutionLease: runtime.runWithExecutionLease,
      };

      yield {
        kind: 'progress',
        message: '执行任务中...',
        data: { subagentType: subagent_type },
      };

      const startTime = Date.now();
      let result: SubagentResult = await executor.execute(subagentContext);
      let duration = Date.now() - startTime;

      try {
        const projectDir = context.contextSnapshot?.cwd;
        if (!projectDir) {
          return buildTaskResult(result, subagent_type, description, duration, subagentSessionId);
        }

        const hookManager = HookManager.getInstance();
        const stopResult = await hookManager.executeSubagentStopHooks(subagent_type, {
          projectDir,
          sessionId: context.sessionId || SessionId('unknown'),
          permissionMode: context.permissionMode ?? PermissionMode.DEFAULT,
          taskDescription: description,
          success: result.success,
          resultSummary: result.message.slice(0, 500),
          error: result.error,
          abortSignal: context.signal,
        });
        context.signal?.throwIfAborted();

        if (!stopResult.shouldStop && stopResult.continueReason) {
          console.log(`[Task] SubagentStop hook 阻止停止，继续执行: ${stopResult.continueReason}`);

          const continueContext: SubagentContext = {
            prompt: stopResult.continueReason,
            parentSessionId: context.sessionId,
            permissionMode: context.permissionMode,
            subagentSessionId,
            snapshot: context.contextSnapshot,
            signal: context.signal,
            executionFence: runtime.executionFence,
            assertExecutionLease: runtime.assertExecutionLease,
            runWithExecutionLease: runtime.runWithExecutionLease,
          };

          const continueStartTime = Date.now();
          result = await executor.execute(continueContext);
          duration += Date.now() - continueStartTime;
        }

        if (stopResult.warning) {
          console.warn(`[Task] SubagentStop hook warning: ${stopResult.warning}`);
        }
      } catch (hookError) {
        if (isExecutionLeaseFailure(hookError) || isHookProcessContainmentError(hookError)) {
          throw hookError;
        }
        context.signal?.throwIfAborted();
        console.warn('[Task] SubagentStop hook execution failed:', hookError);
      }

      return buildTaskResult(result, subagent_type, description, duration, subagentSessionId);
    } catch (error) {
      if (isExecutionLeaseFailure(error) || isHookProcessContainmentError(error)) {
        throw error;
      }
      context.signal?.throwIfAborted();
      return {
        status: 'error',
        model: `Subagent execution error: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: getErrorMessage(error),
          details: error,
        },
        metadata: {
          summary: '子 Agent 执行失败',
        },
      };
    }
  },
  preparePermissionMatcher: (params) => ({
    signatureContent: `${params.subagent_type}:${params.description}`,
    abstractRule: '',
  }),
});

function buildTaskResult(
  result: SubagentResult,
  subagentType: string,
  description: string,
  duration: number,
  subagentSessionId: AgentId,
): ToolResult {
  if (result.success) {
    return {
      status: 'success',
      model: result.message,
      metadata: {
        summary: '子 Agent 执行完成',
        subagent_type: subagentType,
        description,
        duration,
        stats: result.stats,
        subagentSessionId,
        subagentType,
        subagentStatus: 'completed' as const,
        subagentSummary: result.message.slice(0, 500),
      },
    };
  }

  return {
    status: 'error',
    model: `Subagent execution failed: ${result.error}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: result.error || 'Unknown error',
    },
    metadata: {
      summary: '子 Agent 执行失败',
      subagentSessionId,
      subagentType,
      subagentStatus: 'failed' as const,
    },
  };
}

async function handleBackgroundExecution(
  subagentConfig: {
    name: string;
    description: string;
    systemPrompt?: string;
    tools?: string[];
  },
  description: string,
  prompt: string,
  context: ExecutionContext,
  subagentSessionId: AgentId,
  registry: SubagentRegistry,
  manager: IBackgroundAgentManager,
): Promise<ToolResult> {
  const runtime = getRuntimeAccess(context);
  if (!context.bladeConfig) {
    return {
      status: 'error',
      model: 'BladeConfig is required for background agent execution',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
      metadata: {
        summary: '配置缺失',
      },
    };
  }

  const agentId = await manager.startBackgroundAgent({
    config: subagentConfig,
    bladeConfig: context.bladeConfig,
    subagentRegistry: registry,
    description,
    prompt,
    parentSessionId: context.sessionId,
    permissionMode: context.permissionMode,
    agentId: subagentSessionId,
    snapshot: context.contextSnapshot,
    executionFence: runtime.executionFence,
    assertExecutionLease: runtime.assertExecutionLease,
    runWithExecutionLease: runtime.runWithExecutionLease,
  });

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
      subagent_type: subagentConfig.name,
      description,
      background: true,
      subagentSessionId: agentId,
      subagentType: subagentConfig.name,
      subagentStatus: 'running' as const,
    },
  };
}

async function handleResume(
  agentId: AgentId,
  prompt: string,
  subagentConfig: {
    name: string;
    description: string;
    systemPrompt?: string;
    tools?: string[];
  },
  description: string,
  context: ExecutionContext,
  registry: SubagentRegistry,
  manager: IBackgroundAgentManager,
): Promise<ToolResult> {
  const runtime = getRuntimeAccess(context);
  if (!context.bladeConfig) {
    return {
      status: 'error',
      model: 'BladeConfig is required for agent resume',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
      metadata: {
        summary: '配置缺失',
      },
    };
  }

  const session = await manager.getAgent(agentId);
  if (!session) {
    return {
      status: 'error',
      model: `Cannot resume agent ${agentId}: session not found`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Agent session not found: ${agentId}`,
      },
      metadata: {
        summary: '子 Agent 执行失败',
      },
    };
  }

  if (manager.isRunning(agentId)) {
    return {
      status: 'error',
      model: `Cannot resume agent ${agentId}: still running`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Agent is still running: ${agentId}`,
      },
      metadata: {
        summary: '子 Agent 执行失败',
      },
    };
  }

  const newAgentId = await manager.resumeAgent(
    agentId,
    prompt,
    subagentConfig,
    context.bladeConfig,
    context.sessionId,
    context.permissionMode,
    registry,
    description,
    runtime.executionFence,
    runtime.assertExecutionLease,
    runtime.runWithExecutionLease,
  );

  if (!newAgentId) {
    return {
      status: 'error',
      model: `Failed to resume agent ${agentId}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Failed to resume agent: ${agentId}`,
      },
      metadata: {
        summary: '子 Agent 执行失败',
      },
    };
  }

  return {
    status: 'success',
    model: {
      agent_id: newAgentId,
      status: 'running',
      resumed_from: agentId,
      message: `Agent resumed in background. Use TaskOutput(task_id: "${newAgentId}") to retrieve results.`,
    },
    metadata: {
      summary: '子 Agent 恢复完成',
      agent_id: newAgentId,
      resumed_from: agentId,
      subagent_type: subagentConfig.name,
      description,
      background: true,
      subagentSessionId: newAgentId,
      subagentType: subagentConfig.name,
      subagentStatus: 'running' as const,
    },
  };
}
