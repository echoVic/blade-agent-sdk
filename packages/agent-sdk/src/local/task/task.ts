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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult } from '../../tools/types/index.js';

// ============================================================================
// 本地类型定义（替代 root 依赖）
// ============================================================================

type PermissionMode = string;

interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  color?: string;
  configPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  skills?: string[];
  source?: string;
  omitEnvironment?: boolean;
}

interface SubagentContext {
  prompt: string;
  parentSessionId?: string;
  parentMessageId?: string;
  permissionMode?: PermissionMode;
  subagentSessionId?: string;
  snapshot?: Record<string, unknown> & { cwd?: string };
  omitEnvironment?: boolean;
}

interface SubagentResult {
  success: boolean;
  message: string;
  error?: string;
  agentId?: string;
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };
}

export interface SubagentRegistryPort {
  getSubagent(name: string): SubagentConfig | undefined;
  getAllSubagents(): SubagentConfig[];
  loadFromStandardLocations(cwd?: string, configDir?: string): void;
  getAllNames(): string[];
  getDescriptionsForPrompt(): string;
}

interface SubagentExecutorPort {
  execute(config: SubagentConfig, context: Record<string, unknown>): Promise<SubagentResult>;
}

interface BackgroundAgentManagerPort {
  createBackgroundAgent(agentId: string, config: SubagentConfig, context: Record<string, unknown>): void;
  getSubagentStatus(subagentId: string): unknown;
  getAgent(agentId: string): unknown;
  isRunning(agentId: string): boolean;
  killAgent(agentId: string): boolean;
  resumeAgent(
    agentId: string,
    prompt: string,
    subagentConfig: { name: string; description: string; systemPrompt?: string; tools?: string[] },
    bladeConfig: unknown,
    parentSessionId: string,
    permissionMode: PermissionMode | undefined,
    registry: SubagentRegistryPort,
    description: string,
  ): string | null;
  startBackgroundAgent(params: {
    config: { name: string; description: string; systemPrompt?: string; tools?: string[] };
    bladeConfig: unknown;
    subagentRegistry: SubagentRegistryPort;
    description: string;
    prompt: string;
    parentSessionId: string;
    permissionMode: PermissionMode | undefined;
    agentId: string;
    snapshot: unknown;
  }): string;
}

interface SubagentHookPort {
  executeSubagentStopHooks(
    subagentType: string,
    opts: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      taskDescription: string;
      success: boolean;
      resultSummary: string;
      error?: string;
    },
  ): Promise<{ shouldStop: boolean; continueReason?: string; warning?: string }>;
}

// ============================================================================
// 工具函数
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

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

function isValidSubagentType(type: string, registry: SubagentRegistryPort): boolean {
  return registry.getAllNames().includes(type);
}

function getAvailableSubagentTypesMessage(registry: SubagentRegistryPort): string {
  const types = registry.getAllNames();
  return types.length > 0 ? types.join(', ') : 'none (registry not initialized)';
}

function getTaskDescription(registry: SubagentRegistryPort): string {
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

// ============================================================================
// TaskTool - Subagent 调度器
// ============================================================================

export function createTaskTool({ registry }: { registry: SubagentRegistryPort }) {
  return createTool({
    name: 'Task',
    displayName: 'Subagent Scheduler',
    kind: ToolKind.ReadOnly,
    isReadOnly: true,
    isConcurrencySafe: false,
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
      run_in_background: z.boolean().default(false).describe(
        'Set to true to run this agent in the background. Use TaskOutput to read the output later.',
      ),
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
            : randomUUID();

      try {
        const registeredNames = registry.getAllNames();
        const subagentConfig = registry.getSubagent(subagent_type);
        if (!subagentConfig) {
          return {
            success: false,
            llmContent: `Unknown subagent type: ${subagent_type}. Available types: ${registeredNames.join(', ') || 'none'}`,
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

        updateOutput?.(
          `⚙️  Executing ${subagent_type} subagent: ${description}`
        );

        if (!context.bladeConfig) {
          return {
            success: false,
            llmContent: 'BladeConfig is required for subagent execution',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'BladeConfig is required',
            },
            metadata: {
              summary: '配置缺失',
            },
          };
        }

        const executor = (context as Record<string, unknown>).subagentExecutor as SubagentExecutorPort | undefined;
        if (!executor) {
          return {
            success: false,
            llmContent: 'SubagentExecutor not available in execution context',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'SubagentExecutor not injected via ExecutionContext',
            },
            metadata: {
              summary: '操作失败',
            },
          };
        }

        const subagentCtx: Record<string, unknown> = {
          prompt,
          parentSessionId: context.sessionId,
          permissionMode: context.permissionMode,
          subagentSessionId,
          snapshot: context.contextSnapshot,
        };

        updateOutput?.('⚙️  执行任务中...');

        const startTime = Date.now();
        let result: SubagentResult = await executor.execute(subagentConfig, subagentCtx);
        let duration = Date.now() - startTime;

        try {
          const projectDir = (context.contextSnapshot as Record<string, unknown> | undefined)?.cwd as string | undefined;
          if (!projectDir) {
            return buildTaskResult(result, subagent_type, description, duration, subagentSessionId);
          }

          const hookManager = (context as Record<string, unknown>).hookManager as SubagentHookPort | undefined;
          if (hookManager) {
            const stopResult = await hookManager.executeSubagentStopHooks(subagent_type, {
              projectDir,
              sessionId: context.sessionId || 'unknown',
              permissionMode: context.permissionMode ?? 'default',
              taskDescription: description,
              success: result.success,
              resultSummary: result.message.slice(0, 500),
              error: result.error,
            });

            if (!stopResult.shouldStop && stopResult.continueReason) {
              console.log(
                `[Task] SubagentStop hook 阻止停止，继续执行: ${stopResult.continueReason}`
              );

              const continueCtx: Record<string, unknown> = {
                prompt: stopResult.continueReason,
                parentSessionId: context.sessionId,
                permissionMode: context.permissionMode,
                subagentSessionId,
                snapshot: context.contextSnapshot,
              };

              const continueStartTime = Date.now();
              result = await executor.execute(subagentConfig, continueCtx);
              duration += Date.now() - continueStartTime;
            }

            if (stopResult.warning) {
              console.warn(`[Task] SubagentStop hook warning: ${stopResult.warning}`);
            }
          }
        } catch (hookError) {
          console.warn('[Task] SubagentStop hook execution failed:', hookError);
        }

        return buildTaskResult(result, subagent_type, description, duration, subagentSessionId);
      } catch (error) {
        const _errorMessage = extractUserFriendlyError(
          error instanceof Error ? error : new Error(getErrorMessage(error))
        );

        return {
          success: false,
          llmContent: `Subagent execution error: ${getErrorMessage(error)}`,
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
    const _outputPreview =
      result.message.length > 1000
        ? `${result.message.slice(0, 1000)}\n...(截断)`
        : result.message;

    return {
      success: true,
      llmContent: result.message,
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
    success: false,
    llmContent: `Subagent execution failed: ${result.error}`,
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
  registry: SubagentRegistryPort,
): ToolResult {
  if (!context.bladeConfig) {
    return {
      success: false,
      llmContent: 'BladeConfig is required for background agent execution',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
      metadata: {
        summary: '配置缺失',
      },
    };
  }

  const manager = context.backgroundAgentManager as BackgroundAgentManagerPort | undefined;
  if (!manager) {
    return {
      success: false,
      llmContent: 'BackgroundAgentManager not available in execution context',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BackgroundAgentManager not injected via ExecutionContext',
      },
      metadata: {
        summary: '操作失败',
      },
    };
  }

  const agentId = manager.startBackgroundAgent({
    config: subagentConfig,
    bladeConfig: context.bladeConfig,
    subagentRegistry: registry,
    description,
    prompt,
    parentSessionId: context.sessionId ?? '',
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
  registry: SubagentRegistryPort,
): ToolResult {
  if (!context.bladeConfig) {
    return {
      success: false,
      llmContent: 'BladeConfig is required for agent resume',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BladeConfig is required',
      },
      metadata: {
        summary: '配置缺失',
      },
    };
  }

  const manager = context.backgroundAgentManager as BackgroundAgentManagerPort | undefined;
  if (!manager) {
    return {
      success: false,
      llmContent: 'BackgroundAgentManager not available in execution context',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'BackgroundAgentManager not injected via ExecutionContext',
      },
      metadata: {
        summary: '操作失败',
      },
    };
  }

  const session = manager.getAgent(agentId);
  if (!session) {
    return {
      success: false,
      llmContent: `Cannot resume agent ${agentId}: session not found`,
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
      success: false,
      llmContent: `Cannot resume agent ${agentId}: still running`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: `Agent is still running: ${agentId}`,
      },
      metadata: {
        summary: '子 Agent 执行失败',
      },
    };
  }

  const newAgentId = manager.resumeAgent(
    agentId,
    prompt,
    subagentConfig,
    context.bladeConfig,
    context.sessionId ?? '',
    context.permissionMode,
    registry,
    description,
  );

  if (!newAgentId) {
    return {
      success: false,
      llmContent: `Failed to resume agent ${agentId}`,
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
    success: true,
    llmContent: {
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
export const taskTool = createTaskTool;
