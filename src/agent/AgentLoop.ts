/**
 * AgentLoop — 纯 Agent 循环
 *
 * 设计原则（参考 pi-mono agent-loop.ts）：
 * 1. 只负责核心循环：调用 LLM → 检查 tool calls → 执行工具 → 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentLoopEvent, LoopResult> 统一输出
 * 4. 与现有 AgentEvent / LoopResult 类型兼容
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { ChatResponse, IChatService, Message } from '../services/ChatServiceInterface.js';
import type { ToolResult } from '../tools/types/index.js';
import { ToolErrorType } from '../tools/types/index.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { PermissionMode } from '../types/common.js';
import type { StreamResponseHandler } from './StreamResponseHandler.js';
import type { AgentLoopEvent, TokenUsageInfo } from './AgentEvent.js';
import type { LoopResult, TurnLimitResponse } from './types.js';

/** LLM 工具定义（chat service 接受的格式） */
type LlmToolDef = { name: string; description: string; parameters: unknown };

/** 仅 function 类型的 tool call（过滤后的窄类型） */
type FunctionToolCall = ChatCompletionMessageToolCall & { type: 'function'; function: { name: string; arguments: string } };

const logger = createLogger(LogCategory.AGENT);

// ===== Loop 配置 =====

/**
 * AgentLoop 的依赖注入配置
 *
 * 参考 pi-mono 的 AgentLoopConfig，通过 config 对象注入所有外部依赖。
 * Agent.ts 负责组装这个 config，AgentLoop 只消费它。
 */
export interface AgentLoopConfig {
  /** LLM 服务 */
  chatService: IChatService;

  /** 流式响应处理器（可选，无则使用非流式） */
  streamHandler?: StreamResponseHandler;

  /** 工具执行管道 */
  executionPipeline: ExecutionPipeline;

  /** 可用工具定义（已经过权限过滤和 Skill 限制，LLM 格式） */
  tools: LlmToolDef[];

  /** 初始消息列表（包含 system prompt + 历史 + 当前用户消息） */
  messages: Message[];

  /** 最大轮次 */
  maxTurns: number;

  /** 是否为 YOLO 模式（不限制轮次） */
  isYoloMode: boolean;

  /** 中断信号 */
  signal?: AbortSignal;

  /** 权限模式 */
  permissionMode?: PermissionMode;

  /** 当前模型最大上下文 token 数 */
  maxContextTokens: number;

  /** 工具执行上下文 */
  executionContext: {
    sessionId: string;
    userId: string;
    workspaceRoot: string;
    confirmationHandler?: ConfirmationHandler;
  };

  // ===== Hooks（副作用注入） =====

  /**
   * 每轮开始前调用（compaction、消息重建等）
   * 返回 true 表示发生了 compaction
   */
  onBeforeTurn?: (ctx: {
    turn: number;
    messages: Message[];
    lastPromptTokens?: number;
  }) => AsyncGenerator<AgentLoopEvent, boolean>;

  /**
   * LLM 响应后、工具执行前调用
   * 用于保存助手消息到 JSONL 等
   */
  onAssistantMessage?: (ctx: {
    content: string;
    reasoningContent?: string;
    toolCalls?: ChatCompletionMessageToolCall[];
    turn: number;
  }) => Promise<void>;

  /**
   * 工具执行前调用（每个工具）
   * 用于保存 tool_use 到 JSONL
   * 返回 toolUseUuid
   */
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: Record<string, unknown>;
  }) => Promise<string | null>;

  /**
   * 工具执行后调用（每个工具）
   * 用于保存 tool_result 到 JSONL、模型切换、Skill 激活等
   */
  onAfterToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    result: ToolResult;
    toolUseUuid: string | null;
  }) => Promise<void>;

  /**
   * Agent 正常结束时调用（无 tool calls）
   * 用于保存最终响应到 JSONL
   */
  onComplete?: (ctx: {
    content: string;
    turn: number;
  }) => Promise<void>;

  /**
   * 轮次上限到达时调用
   */
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;

  /**
   * Stop Hook 检查
   * 返回 { shouldStop, continueReason } 
   */
  onStopCheck?: (ctx: {
    content: string;
    turn: number;
  }) => Promise<{ shouldStop: boolean; continueReason?: string; warning?: string }>;

  /**
   * 轮次上限后的 compaction 处理
   */
  onTurnLimitCompact?: (ctx: {
    messages: Message[];
    contextMessages: Message[];
  }) => Promise<{
    success: boolean;
    compactedMessages?: Message[];
    continueMessage?: Message;
  }>;
}

// ===== 意图未完成检测 =====

const INCOMPLETE_INTENT_PATTERNS = [
  /：\s*$/, // 中文冒号结尾
  /:\s*$/, // 英文冒号结尾
  /\.\.\.\s*$/, // 省略号结尾
  /让我(先|来|开始|查看|检查|修复)/, // 中文意图词
  /Let me (first|start|check|look|fix)/i, // 英文意图词
];

const RETRY_PROMPT = '请执行你提到的操作，不要只是描述。';

function isIncompleteIntent(content: string): boolean {
  return INCOMPLETE_INTENT_PATTERNS.some((p) => p.test(content));
}

function countRecentRetries(messages: Message[]): number {
  return messages
    .slice(-10)
    .filter((m) => m.role === 'user' && m.content === RETRY_PROMPT).length;
}

// ===== 核心循环 =====

/**
 * 运行 Agent 循环
 *
 * 纯函数式设计：接收配置，产出事件流，返回结果。
 * 所有副作用通过 hooks 注入。
 */
export async function* agentLoop(
  config: AgentLoopConfig
): AsyncGenerator<AgentLoopEvent, LoopResult> {
  const {
    chatService,
    streamHandler,
    executionPipeline,
    tools,
    messages,
    maxTurns,
    isYoloMode,
    signal,
    permissionMode,
    maxContextTokens,
    executionContext,
  } = config;

  const SAFETY_LIMIT = 100;
  const effectiveMaxTurns = isYoloMode ? SAFETY_LIMIT : maxTurns;

  const startTime = Date.now();
  let turnsCount = 0;
  const allToolResults: ToolResult[] = [];
  let totalTokens = 0;
  let lastPromptTokens: number | undefined;

  yield { type: 'agent_start' };

  // === Agentic Loop ===
  while (true) {
    // 1. 检查中断信号
    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(turnsCount, allToolResults.length, startTime);
    }

    // 2. Before-turn hook（compaction 等）
    if (config.onBeforeTurn) {
      const beforeTurnStream = config.onBeforeTurn({
        turn: turnsCount,
        messages,
        lastPromptTokens,
      });
      // 消费 hook 产出的事件（如 compacting 事件）
      while (true) {
        const { value, done } = await beforeTurnStream.next();
        if (done) break;
        yield value;
      }
    }

    // 3. 轮次计数
    turnsCount++;
    yield { type: 'turn_start', turn: turnsCount, maxTurns: effectiveMaxTurns };

    // 再次检查 abort
    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(turnsCount - 1, allToolResults.length, startTime);
    }

    // 4. 调用 LLM
    let turnResult: ChatResponse;
    if (streamHandler) {
      const stream = streamHandler.streamResponse(messages, tools, signal);
      while (true) {
        const { value, done } = await stream.next();
        if (done) {
          turnResult = value;
          break;
        }
        if (value.type === 'content_delta') {
          yield { type: 'content_delta', delta: value.delta };
        } else {
          yield { type: 'thinking_delta', delta: value.delta };
        }
      }
    } else {
      turnResult = await chatService.chat(messages, tools, signal);
    }

    // 5. Token usage
    if (turnResult.usage) {
      if (turnResult.usage.totalTokens) {
        totalTokens += turnResult.usage.totalTokens;
      }
      lastPromptTokens = turnResult.usage.promptTokens;

      const usage: TokenUsageInfo = {
        inputTokens: turnResult.usage.promptTokens ?? 0,
        outputTokens: turnResult.usage.completionTokens ?? 0,
        totalTokens,
        maxContextTokens,
      };
      yield { type: 'token_usage', usage };
    }

    // 检查 abort（LLM 调用后）
    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(turnsCount - 1, allToolResults.length, startTime);
    }

    // 6. Thinking 内容
    if (turnResult.reasoningContent && !signal?.aborted) {
      yield { type: 'thinking', content: turnResult.reasoningContent };
    }

    // 7. 文本内容
    if (turnResult.content?.trim() && !signal?.aborted) {
      yield { type: 'stream_end' };
    }

    // 8. 检查是否有 tool calls
    if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
      // === 意图未完成检测 ===
      const content = turnResult.content || '';
      if (isIncompleteIntent(content) && countRecentRetries(messages) < 2) {
        messages.push({ role: 'user', content: RETRY_PROMPT });
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        continue;
      }

      // === Stop Hook ===
      if (config.onStopCheck) {
        const stopResult = await config.onStopCheck({ content, turn: turnsCount });
        if (!stopResult.shouldStop) {
          const continueMessage = stopResult.continueReason
            ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
            : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';
          messages.push({ role: 'user', content: continueMessage });
          yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
          continue;
        }
      }

      // === 正常结束 ===
      await config.onComplete?.({ content, turn: turnsCount });

      yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
      yield { type: 'agent_end' };
      return {
        success: true,
        finalMessage: turnResult.content,
        metadata: {
          turnsCount,
          toolCallsCount: allToolResults.length,
          duration: Date.now() - startTime,
          tokensUsed: totalTokens,
        },
      };
    }

    // 9. 添加 LLM 响应到消息历史
    messages.push({
      role: 'assistant',
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      tool_calls: turnResult.toolCalls,
    });

    // 通知 hook
    await config.onAssistantMessage?.({
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      toolCalls: turnResult.toolCalls,
      turn: turnsCount,
    });

    // 10. 执行工具
    const functionCalls = turnResult.toolCalls.filter(
      (tc): tc is FunctionToolCall => tc.type === 'function'
    );

    // 发射 tool_start 事件
    for (const toolCall of functionCalls) {
      const toolDef = executionPipeline.getRegistry().get(toolCall.function.name);
      const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
      yield { type: 'tool_start', toolCall, toolKind };
    }

    // 检查 abort
    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(turnsCount, allToolResults.length, startTime);
    }

    // 并行执行工具
    const executionResults = await Promise.all(
      functionCalls.map((toolCall) =>
        executeToolCall(toolCall, executionPipeline, executionContext, config, signal)
      )
    );

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      allToolResults.push(result);

      // 检查退出循环标记
      if (result.metadata?.shouldExitLoop) {
        const finalMessage =
          typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';
        yield { type: 'tool_result', toolCall, result };
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: true };
        yield { type: 'agent_end' };
        return {
          success: result.success,
          finalMessage,
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            shouldExitLoop: true,
            targetMode: result.metadata?.targetMode as PermissionMode | undefined,
          },
        };
      }

      yield { type: 'tool_result', toolCall, result };

      // After-tool hook（JSONL 保存、模型切换等）
      await config.onAfterToolExec?.({ toolCall, result, toolUseUuid });

      // 添加工具结果到消息历史
      let toolResultContent = result.success
        ? result.llmContent || result.displayContent || ''
        : result.error?.message || '执行失败';

      if (typeof toolResultContent === 'object' && toolResultContent !== null) {
        toolResultContent = JSON.stringify(toolResultContent, null, 2);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: typeof toolResultContent === 'string'
          ? toolResultContent
          : JSON.stringify(toolResultContent),
      });
    }

    yield { type: 'turn_end', turn: turnsCount, hasToolCalls: true };

    // 检查 abort（工具执行后）
    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(turnsCount, allToolResults.length, startTime);
    }

    // 11. 检查轮次上限
    if (turnsCount >= effectiveMaxTurns && !isYoloMode) {
      const limitResult = await handleTurnLimit(
        config, messages, turnsCount, allToolResults.length,
        startTime, totalTokens, lastPromptTokens
      );
      if (limitResult.action === 'stop') {
        yield { type: 'agent_end' };
        return limitResult.result;
      }
      // action === 'continue': 重置轮次
      turnsCount = 0;
      continue;
    }
  }
}

// ===== 辅助函数 =====

function buildAbortResult(
  turnsCount: number,
  toolCallsCount: number,
  startTime: number
): LoopResult {
  return {
    success: false,
    error: {
      type: 'aborted',
      message: '任务已被用户中止',
    },
    metadata: {
      turnsCount,
      toolCallsCount,
      duration: Date.now() - startTime,
    },
  };
}

/**
 * 执行单个工具调用
 */
async function executeToolCall(
  toolCall: FunctionToolCall,
  executionPipeline: ExecutionPipeline,
  executionContext: AgentLoopConfig['executionContext'],
  config: AgentLoopConfig,
  signal?: AbortSignal
): Promise<{
  toolCall: FunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}> {
  try {
    const params = JSON.parse(toolCall.function.arguments);

    // 智能修复: Task 工具的 subagent_session_id
    if (
      toolCall.function.name === 'Task' &&
      (typeof params.subagent_session_id !== 'string' ||
        params.subagent_session_id.length === 0)
    ) {
      const { nanoid } = await import('nanoid');
      params.subagent_session_id =
        typeof params.resume === 'string' && params.resume.length > 0
          ? params.resume
          : nanoid();
    }

    // 智能修复: todos 参数字符串化
    if (params.todos && typeof params.todos === 'string') {
      try {
        params.todos = JSON.parse(params.todos);
      } catch {
        // 由验证层处理
      }
    }

    // Before-tool hook（保存 tool_use 到 JSONL）
    const toolUseUuid = await config.onBeforeToolExec?.({
      toolCall,
      params,
    }) ?? null;

    // 执行工具
    const result = await executionPipeline.execute(
      toolCall.function.name,
      params,
      {
        sessionId: executionContext.sessionId,
        userId: executionContext.userId,
        workspaceRoot: executionContext.workspaceRoot,
        signal,
        confirmationHandler: executionContext.confirmationHandler,
        permissionMode: config.permissionMode,
      }
    );

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
    };
  }
}

/**
 * 处理轮次上限
 */
async function handleTurnLimit(
  config: AgentLoopConfig,
  messages: Message[],
  turnsCount: number,
  toolCallsCount: number,
  startTime: number,
  totalTokens: number,
  _lastPromptTokens?: number
): Promise<{ action: 'stop' | 'continue'; result: LoopResult }> {
  if (config.onTurnLimitReached) {
    const response = await config.onTurnLimitReached({ turnsCount });

    if (response?.continue) {
      // 用户选择继续，尝试 compaction
      if (config.onTurnLimitCompact) {
        const compactResult = await config.onTurnLimitCompact({
          messages,
          contextMessages: messages.filter((m) => m.role !== 'system'),
        });

        if (compactResult.success && compactResult.compactedMessages) {
          // 重建 messages
          const systemMsg = messages.find((m) => m.role === 'system');
          messages.length = 0;
          if (systemMsg) messages.push(systemMsg);
          messages.push(...compactResult.compactedMessages);
          if (compactResult.continueMessage) {
            messages.push(compactResult.continueMessage);
          }
        }
      }

      return {
        action: 'continue',
        result: { success: true, metadata: { turnsCount, toolCallsCount, duration: Date.now() - startTime } },
      };
    }

    // 用户选择停止
    return {
      action: 'stop',
      result: {
        success: true,
        metadata: {
          turnsCount,
          toolCallsCount,
          duration: Date.now() - startTime,
          tokensUsed: totalTokens,
          configuredMaxTurns: config.maxTurns,
          actualMaxTurns: config.maxTurns,
        },
      },
    };
  }

  // 非交互模式：直接停止
  return {
    action: 'stop',
    result: {
      success: false,
      error: {
        type: 'max_turns_exceeded',
        message: `达到最大轮次限制 (${config.maxTurns})`,
      },
      metadata: {
        turnsCount,
        toolCallsCount,
        duration: Date.now() - startTime,
        tokensUsed: totalTokens,
      },
    },
  };
}
