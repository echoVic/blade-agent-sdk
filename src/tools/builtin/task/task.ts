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
import { z } from 'zod';
import { BackgroundAgentManager } from '../../../agent/subagents/BackgroundAgentManager.js';
import type { SubagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import { SubagentExecutor } from '../../../agent/subagents/SubagentExecutor.js';
import type {
  SubagentContext,
  SubagentResult,
} from '../../../agent/subagents/types.js';
import { HookManager } from '../../../hooks/HookManager.js';
import { PermissionMode } from '../../../types/common.js';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * 从错误中提取用户友好的错误信息
 */
function extractUserFriendlyError(error: Error): string {
  const message = error.message || 'Unknown error';

  if (message.includes('Too Many Requests') || message.includes('429')) {
    const cause = (error as { cause?: { responseBody?: string } }).cause;
    if (cause?.responseBody) {
      try {
        const body = JSON.parse(cause.responseBody);
        if (body.message) {
          return body.message;
        }
      } catch {
        // 忽略解析错误
      }
    }
    return 'API 请求过于频繁，请稍后重试';
  }

  if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
    return '网络连接失败，请检查网络设置';
  }

  if (message.includes('401') || message.includes('Unauthorized')) {
    return 'API 认证失败，请检查 API Key 配置';
  }

  return message.split('\n')[0];
}

function isValidSubagentType(type: string, registry: SubagentRegistry): boolean {
  return registry.getAllNames().includes(type);
}

function getAvailableSubagentTypesMessage(registry: SubagentRegistry): string {
  const types = registry.getAllNames();
  return types.length > 0 ? types.join(', ') : 'none (registry not initialized)';
}

function getTaskDescription(registry: SubagentRegistry): string {
  return `
## Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${registry.getDescriptionsForPrompt()}

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
export function createTaskTool({ registry }: { registry: SubagentRegistry }) {
  return createTool({
    name: 'Task',
    displayName: 'Subagent Scheduler',
    kind: ToolKind.ReadOnly,
    isReadOnly: true,
    schema: z.object({
      subagent_type: z
        .string()
        .refine((type) => isValidSubagentType(type, registry), (val) => ({
          message: `Invalid subagent type: "${val}". Available: ${getAvailableSubagentTypesMessage(registry)}`,
        }))
        .describe('Subagent type to use (e.g., "Explore", "Plan")'),
      description: z
        .string()
        .min(3)
        .max(100)
        .describe('Short task description (3-5 words)'),
      prompt: z.string().min(10).describe('Detailed task instructions'),
      run_in_background: ToolSchemas.flag({
        defaultValue: false,
        description:
          'Set to true to run this agent in the background. Use TaskOutput to read the output later.',
      }),
      resume: z
        .string()
        .optional()
        .describe(
          'Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.'
        ),
      subagent_session_id: z
        .string()
        .optional()
        .describe('Internal subagent session id for tracking'),
    }),
    description: {
      short: 'Launch a new agent to handle complex, multi-step tasks autonomously',
      get long() {
        return getTaskDescription(registry);
      },
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
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const {
        subagent_type,
        description,
        prompt,
        run_in_background = false,
        resume,
        subagent_session_id,
      } = params;
      const { updateOutput } = context;
      const subagentSessionId =
        typeof subagent_session_id === 'string' && subagent_session_id.length > 0
          ? subagent_session_id
          : typeof resume === 'string' && resume.length > 0
            ? resume
            : nanoid();

      try {
        const registeredNames = registry.getAllNames();
        const subagentConfig = registry.getSubagent(subagent_type);
        if (!subagentConfig) {
          return {
            success: false,
            llmContent: `Unknown subagent type: ${subagent_type}. Available types: ${registeredNames.join(', ') || 'none'}`,
            displayContent: `❌ 未知的 subagent 类型: ${subagent_type}\n\n可用类型: ${registeredNames.join(', ') || '无'}`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: `Unknown subagent type: ${subagent_type}`,
            },
          };
        }

        if (resume) {
          return handleResume(
            resume,
            prompt,
            subagentConfig,
            description,
            context,
            registry,
          );
        }

        if (run_in_background) {
          return handleBackgroundExecution(
            subagentConfig,
            description,
            prompt,
            context,
            subagentSessionId,
            registry,
          );
        }

        updateOutput?.(`🚀 启动 ${subagent_type} subagent: ${description}`);

        if (!context.bladeConfig) {
          return {
            success: false,
            llmContent: 'BladeConfig is required for subagent execution',
            displayContent: '❌ 缺少 BladeConfig 配置',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'BladeConfig is required',
            },
          };
        }

        const executor = new SubagentExecutor(subagentConfig, context.bladeConfig, registry);
        const subagentContext: SubagentContext = {
          prompt,
          parentSessionId: context.sessionId,
          permissionMode: context.permissionMode,
          subagentSessionId,
          snapshot: context.contextSnapshot,
        };

        updateOutput?.('⚙️  执行任务中...');

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
            sessionId: context.sessionId || 'unknown',
            permissionMode: context.permissionMode ?? PermissionMode.DEFAULT,
            taskDescription: description,
            success: result.success,
            resultSummary: result.message.slice(0, 500),
            error: result.error,
          });

          if (!stopResult.shouldStop && stopResult.continueReason) {
            console.log(
              `[Task] SubagentStop hook 阻止停止，继续执行: ${stopResult.continueReason}`
            );

            const continueContext: SubagentContext = {
              prompt: stopResult.continueReason,
              parentSessionId: context.sessionId,
              permissionMode: context.permissionMode,
              subagentSessionId,
              snapshot: context.contextSnapshot,
            };

            const continueStartTime = Date.now();
            result = await executor.execute(continueContext);
            duration += Date.now() - continueStartTime;
          }

          if (stopResult.warning) {
            console.warn(`[Task] SubagentStop hook warning: ${stopResult.warning}`);
          }
        } catch (hookError) {
          console.warn('[Task] SubagentStop hook execution failed:', hookError);
        }

        return buildTaskResult(result, subagent_type, description, duration, subagentSessionId);
      } catch (error) {
        const errorMessage = extractUserFriendlyError(
          error instanceof Error ? error : new Error(getErrorMessage(error))
        );

        return {
          success: false,
          llmContent: `Subagent execution error: ${getErrorMessage(error)}`,
          displayContent: `❌ Subagent 执行异常\n\n${errorMessage}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: getErrorMessage(error),
            details: error,
          },
        };
      }
    },
    version: '4.0.0',
    category: 'Subagent',
    tags: ['task', 'subagent', 'delegation', 'explore', 'plan'],
    preparePermissionMatcher: (params) => ({
      signatureContent: `${params.subagent_type}:${params.description}`,
      abstractRule: '',
    }),
  });
}

function buildTaskResult(
  result: SubagentResult,
  subagentType: string,
  description: string,
  duration: number,
  subagentSessionId: string,
): ToolResult {
  if (result.success) {
    const outputPreview =
      result.message.length > 1000
        ? result.message.slice(0, 1000) + '\n...(截断)'
        : result.message;

    return {
      success: true,
      llmContent: result.message,
      displayContent:
        `✅ Subagent 任务完成\n\n` +
        `类型: ${subagentType}\n` +
        `任务: ${description}\n` +
        `Agent ID: ${result.agentId || 'N/A'}\n` +
        `耗时: ${duration}ms\n` +
        `工具调用: ${result.stats?.toolCalls || 0} 次\n` +
        `Token: ${result.stats?.tokens || 0}\n\n` +
        `结果:\n${outputPreview}`,
      metadata: {
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
    success: false,
    llmContent: `Subagent execution failed: ${result.error}`,
    displayContent:
      `⚠️ Subagent 任务失败\n\n` +
      `类型: ${subagentType}\n` +
      `任务: ${description}\n` +
      `Agent ID: ${result.agentId || 'N/A'}\n` +
      `耗时: ${duration}ms\n` +
      `错误: ${result.error}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: result.error || 'Unknown error',
    },
    metadata: {
      subagentSessionId,
      subagentType,
      subagentStatus: 'failed' as const,
    },
  };
}

function handleBackgroundExecution(
  subagentConfig: {
    name: string;
    description: string;
    systemPrompt?: string;
    tools?: string[];
  },
  description: string,
  prompt: string,
  context: ExecutionContext,
  subagentSessionId: string,
  registry: SubagentRegistry,
): ToolResult {
  if (!context.bladeConfig) {
    return {
      success: false,
      llmContent: 'BladeConfig is required for background agent execution',
      displayContent: '❌ 缺少 BladeConfig 配置',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
    };
  }

  const manager = BackgroundAgentManager.getInstance();

  const agentId = manager.startBackgroundAgent({
    config: subagentConfig,
    bladeConfig: context.bladeConfig,
    subagentRegistry: registry,
    description,
    prompt,
    parentSessionId: context.sessionId,
    permissionMode: context.permissionMode,
    agentId: subagentSessionId,
    snapshot: context.contextSnapshot,
  });

  return {
    success: true,
    llmContent: {
      agent_id: agentId,
      status: 'running',
      message: `Agent started in background. Use TaskOutput(task_id: "${agentId}") to retrieve results.`,
    },
    displayContent:
      `🚀 后台 Agent 已启动\n\n` +
      `Agent ID: ${agentId}\n` +
      `类型: ${subagentConfig.name}\n` +
      `任务: ${description}\n\n` +
      `💡 使用 TaskOutput 工具获取结果`,
    metadata: {
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

function handleResume(
  agentId: string,
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
): ToolResult {
  if (!context.bladeConfig) {
    return {
      success: false,
      llmContent: 'BladeConfig is required for agent resume',
      displayContent: '❌ 缺少 BladeConfig 配置',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
    };
  }

  const manager = BackgroundAgentManager.getInstance();
  const session = manager.getAgent(agentId);
  if (!session) {
    return {
      success: false,
      llmContent: `Cannot resume agent ${agentId}: session not found`,
      displayContent: `❌ 无法恢复 Agent: ${agentId}\n\n会话不存在或已过期`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Agent session not found: ${agentId}`,
      },
    };
  }

  if (manager.isRunning(agentId)) {
    return {
      success: false,
      llmContent: `Cannot resume agent ${agentId}: still running`,
      displayContent: `❌ 无法恢复 Agent: ${agentId}\n\nAgent 仍在运行中，我会使用 TaskOutput 获取结果`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Agent is still running: ${agentId}`,
      },
    };
  }

  const newAgentId = manager.resumeAgent(
    agentId,
    prompt,
    subagentConfig,
    context.bladeConfig,
    context.sessionId,
    context.permissionMode,
    registry,
    description,
  );

  if (!newAgentId) {
    return {
      success: false,
      llmContent: `Failed to resume agent ${agentId}`,
      displayContent: `❌ 恢复 Agent 失败: ${agentId}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Failed to resume agent: ${agentId}`,
      },
    };
  }

  return {
    success: true,
    llmContent: {
      agent_id: newAgentId,
      status: 'running',
      resumed_from: agentId,
      message: `Agent resumed in background. Use TaskOutput(task_id: "${newAgentId}") to retrieve results.`,
    },
    displayContent:
      `🔄 Agent 已恢复执行\n\n` +
      `Agent ID: ${newAgentId}\n` +
      `恢复自: ${agentId}\n` +
      `类型: ${subagentConfig.name}\n` +
      `任务: ${description}\n\n` +
      `💡 使用 TaskOutput 工具获取结果`,
    metadata: {
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
