import { nanoid } from 'nanoid';
import type { ContextManager } from '../context/ContextManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import { ToolErrorType, type ToolResult } from '../tools/types/index.js';
import type { JsonValue } from '../types/common.js';
import type { ChatContext, LoopOptions } from './types.js';

const logger = createLogger(LogCategory.AGENT);

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolExecutionResult {
  toolCall: ToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
  error?: Error;
}

export interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export class ToolExecutionHandler {
  constructor(
    private executionPipeline: ExecutionPipeline,
    private getContextManager: () => ContextManager | undefined
  ) {}

  async executeToolCalls(
    toolCalls: ToolCall[],
    context: ChatContext,
    options: LoopOptions | undefined,
    lastMessageUuid: string | null,
    callbacks: {
      onToolStart?: (toolCall: ToolCall, kind?: 'readonly' | 'write' | 'execute') => void;
      onToolResult?: (toolCall: ToolCall, result: ToolResult) => Promise<void>;
      onTodoUpdate?: (todos: TodoItem[]) => void;
      onSkillActivated?: (ctx: SkillExecutionContext) => void;
      onModelSwitch?: (modelId: string) => Promise<void>;
    }
  ): Promise<{
    results: ToolExecutionResult[];
    lastMessageUuid: string | null;
    shouldExit?: boolean;
    exitResult?: {
      success: boolean;
      finalMessage: string;
      targetMode?: string;
    };
  }> {
    const functionCalls = toolCalls.filter((tc) => tc.type === 'function');

    if (callbacks.onToolStart && !options?.signal?.aborted) {
      for (const toolCall of functionCalls) {
        const toolDef = this.executionPipeline.getRegistry().get(toolCall.function.name);
        const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
        callbacks.onToolStart(toolCall, toolKind);
      }
    }

    logger.info(`[Agent] Executing ${functionCalls.length} tool calls in parallel`);
    const executionResults = await Promise.all(
      functionCalls.map((tc) => this.executeToolCall(tc, context, options, lastMessageUuid))
    );

    let currentLastUuid = lastMessageUuid;

    for (const execResult of executionResults) {
      const { toolCall, result, toolUseUuid } = execResult;

      if (result.metadata?.shouldExitLoop) {
        logger.debug('🚪 检测到退出循环标记，结束 Agent 循环');
        return {
          results: executionResults,
          lastMessageUuid: currentLastUuid,
          shouldExit: true,
          exitResult: {
            success: result.success,
            finalMessage: typeof result.llmContent === 'string' ? result.llmContent : '循环已退出',
            targetMode: result.metadata?.targetMode as string | undefined,
          },
        };
      }

      if (callbacks.onToolResult && !options?.signal?.aborted) {
        try {
          await callbacks.onToolResult(toolCall, result);
        } catch (err) {
          logger.error('[Agent] onToolResult callback error:', err);
        }
      }

      currentLastUuid = await this.saveToolResult(
        context,
        toolCall,
        result,
        toolUseUuid,
        currentLastUuid
      );

      if (toolCall.function.name === 'TodoWrite' && result.success && result.llmContent) {
        const content = typeof result.llmContent === 'object' ? result.llmContent : {};
        const todos = Array.isArray(content)
          ? content
          : ((content as Record<string, unknown>).todos as unknown[]) || [];
        callbacks.onTodoUpdate?.(todos as TodoItem[]);
      }

      if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
        const metadata = result.metadata as Record<string, unknown>;
        if (metadata.skillName) {
          callbacks.onSkillActivated?.({
            skillName: metadata.skillName as string,
            allowedTools: metadata.allowedTools as string[] | undefined,
            basePath: (metadata.basePath as string) || '',
          });
        }
      }

      const modelId =
        (result.metadata?.modelId as string)?.trim() ||
        (result.metadata?.model as string)?.trim() ||
        undefined;
      if (modelId && callbacks.onModelSwitch) {
        await callbacks.onModelSwitch(modelId);
      }
    }

    return {
      results: executionResults,
      lastMessageUuid: currentLastUuid,
    };
  }

  private async executeToolCall(
    toolCall: ToolCall,
    context: ChatContext,
    options: LoopOptions | undefined,
    lastMessageUuid: string | null
  ): Promise<ToolExecutionResult> {
    try {
      const params = JSON.parse(toolCall.function.arguments);

      if (
        toolCall.function.name === 'Task' &&
        (typeof params.subagent_session_id !== 'string' || params.subagent_session_id.length === 0)
      ) {
        params.subagent_session_id =
          typeof params.resume === 'string' && params.resume.length > 0
            ? params.resume
            : nanoid();
      }

      if (params.todos && typeof params.todos === 'string') {
        try {
          params.todos = JSON.parse(params.todos);
          logger.debug('[Agent] 自动修复了字符串化的 todos 参数');
        } catch {
          logger.error('[Agent] todos 参数格式异常,将由验证层处理');
        }
      }

      let toolUseUuid: string | null = null;
      try {
        const contextMgr = this.getContextManager();
        if (contextMgr && context.sessionId) {
          toolUseUuid = await contextMgr.saveToolUse(
            context.sessionId,
            toolCall.function.name,
            params,
            lastMessageUuid,
            context.subagentInfo
          );
        }
      } catch (error) {
        logger.warn('[Agent] 保存工具调用失败:', error);
      }

      const result = await this.executionPipeline.execute(toolCall.function.name, params, {
        sessionId: context.sessionId,
        userId: context.userId || 'default',
        workspaceRoot: context.workspaceRoot || process.cwd(),
        signal: options?.signal,
        confirmationHandler: context.confirmationHandler,
        permissionMode: context.permissionMode,
      });

      logger.debug('\n========== 工具执行结果 ==========');
      logger.debug('工具名称:', toolCall.function.name);
      logger.debug('成功:', result.success);
      logger.debug('LLM Content:', result.llmContent);
      if (result.error) {
        logger.debug('错误:', result.error);
      }
      logger.debug('==================================\n');

      return { toolCall, result, toolUseUuid };
    } catch (error) {
      logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
      return {
        toolCall,
        result: {
          success: false,
          llmContent: '',
          displayContent: '',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        toolUseUuid: null,
        error: error instanceof Error ? error : new Error('Unknown error'),
      };
    }
  }

  private async saveToolResult(
    context: ChatContext,
    toolCall: ToolCall,
    result: ToolResult,
    toolUseUuid: string | null,
    lastMessageUuid: string | null
  ): Promise<string | null> {
    try {
      const contextMgr = this.getContextManager();
      if (!contextMgr || !context.sessionId) {
        return lastMessageUuid;
      }

      const metadata =
        result.metadata && typeof result.metadata === 'object'
          ? (result.metadata as Record<string, unknown>)
          : undefined;

      const isSubagentStatus = (
        value: unknown
      ): value is 'running' | 'completed' | 'failed' | 'cancelled' =>
        value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled';

      const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
        ? metadata.subagentStatus
        : 'completed';

      const subagentRef =
        metadata && typeof metadata.subagentSessionId === 'string'
          ? {
              subagentSessionId: metadata.subagentSessionId,
              subagentType:
                typeof metadata.subagentType === 'string'
                  ? metadata.subagentType
                  : toolCall.function.name,
              subagentStatus,
              subagentSummary:
                typeof metadata.subagentSummary === 'string' ? metadata.subagentSummary : undefined,
            }
          : undefined;

      return await contextMgr.saveToolResult(
        context.sessionId,
        toolCall.id,
        toolCall.function.name,
        result.success ? toJsonValue(result.llmContent) : null,
        toolUseUuid,
        result.success ? undefined : result.error?.message,
        context.subagentInfo,
        subagentRef
      );
    } catch (err) {
      logger.warn('[Agent] 保存工具结果失败:', err);
      return lastMessageUuid;
    }
  }

  buildToolResultMessage(
    toolCall: ToolCall,
    result: ToolResult
  ): { role: 'tool'; tool_call_id: string; name: string; content: string } {
    let toolResultContent = result.success
      ? result.llmContent || result.displayContent || ''
      : result.error?.message || '执行失败';

    if (typeof toolResultContent === 'object' && toolResultContent !== null) {
      toolResultContent = JSON.stringify(toolResultContent, null, 2);
    }

    const finalContent =
      typeof toolResultContent === 'string' ? toolResultContent : JSON.stringify(toolResultContent);

    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: finalContent,
    };
  }
}
