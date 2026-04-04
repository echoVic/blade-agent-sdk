/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责核心循环：调用 LLM → 检查 tool calls → 执行工具 → 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 * 4. 与现有 AgentEvent / LoopResult 类型兼容
 */

import type { InternalLogger } from '../logging/Logger.js';
import type { ContextSnapshot } from '../runtime/index.js';
import type { ChatResponse, IChatService, Message, ToolCall } from '../services/ChatServiceInterface.js';
import { FallbackTriggeredError } from '../services/RetryPolicy.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ConfirmationHandler } from '../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../tools/types/index.js';
import type { PermissionMode } from '../types/common.js';
import type { AgentEvent, TokenUsageInfo } from './AgentEvent.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import { decideNoToolTurn } from './loop/decideNoToolTurn.js';
import { decideTurnLimit } from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { planToolExecution } from './loop/planToolExecution.js';
import type { FunctionToolCall } from './loop/types.js';
import { StreamingToolExecutor } from './StreamingToolExecutor.js';
import type { StreamResponseHandler } from './StreamResponseHandler.js';
import type { TokenBudget } from './TokenBudget.js';
import type { LoopResult, TurnLimitResponse } from './types.js';
import { isOverflowRecoverable } from './recovery/isOverflowRecoverable.js';

/** LLM 工具定义（chat service 接受的格式） */
type LlmToolDef = { name: string; description: string; parameters: unknown };

// ===== Loop 配置 =====

/**
 * AgentLoop 的依赖注入配置
 * 通过 config 对象注入所有外部依赖。
 * Agent.ts 负责组装这个 config，AgentLoop 只消费它。
 */
export interface AgentLoopConfig {
  /** LLM 服务 */
  chatService: IChatService;

  /** 流式响应处理器（可选，无则使用非流式） */
  streamHandler?: StreamResponseHandler;

  /** 工具执行管道 */
  executionPipeline: ExecutionPipeline;

  /** 内部日志器 */
  logger?: InternalLogger;

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

  /** Token 预算 */
  tokenBudget?: TokenBudget;

  /** 工具执行上下文 */
  executionContext: {
    sessionId: string;
    userId: string;
    contextSnapshot?: ContextSnapshot;
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
  }) => AsyncGenerator<AgentEvent, boolean>;

  /**
   * LLM 响应后、工具执行前调用
   * 用于保存助手消息到 JSONL 等
   */
  onAssistantMessage?: (ctx: {
    content: string;
    reasoningContent?: string;
    toolCalls?: ToolCall[];
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
   * 反应式压缩：当 LLM 返回 context-length 错误时调用
   */
  onReactiveCompact?: (ctx: {
    messages: Message[];
  }) => AsyncGenerator<AgentEvent, boolean>;

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

// ===== 核心循环 =====

/**
 * 运行 Agent 循环
 *
 * 纯函数式设计：接收配置，产出事件流，返回结果。
 * 所有副作用通过 hooks 注入。
 */
export async function* agentLoop(
  config: AgentLoopConfig
): AsyncGenerator<AgentEvent, LoopResult> {
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
    tokenBudget,
    executionContext,
  } = config;

  const effectiveMaxTurns = isYoloMode ? AGENT_TURN_SAFETY_LIMIT : maxTurns;

  const startTime = Date.now();
  let turnsCount = 0;
  const allToolResults: ToolResult[] = [];
  let totalTokens = 0;
  let lastPromptTokens: number | undefined;
  let recoveryAttemptedTurn: number | null = null;

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

    // 4. 调用 LLM（带 context-length 错误的反应式压缩）
    let turnResult: ChatResponse | undefined;
    let streamingExecutionResults:
      | Array<{
          toolCall: FunctionToolCall;
          result: ToolResult;
          toolUseUuid: string | null;
        }>
      | undefined;
    try {
      if (streamHandler && tools.length > 0) {
        const streamingExecutor = new StreamingToolExecutor(
          streamHandler,
          () => chatService,
          config.logger,
        );
        const pendingEvents: AgentEvent[] = [];
        let waitForEventsResolve: (() => void) | null = null;
        let executionDone = false;
        let executionError: unknown;

        const flushWaiter = () => {
          const resolve = waitForEventsResolve;
          waitForEventsResolve = null;
          resolve?.();
        };

        const enqueueEvent = (event: AgentEvent) => {
          pendingEvents.push(event);
          flushWaiter();
        };

        const executionPromise = streamingExecutor
          .collectAndExecute(messages, tools, signal, {
            executionPipeline,
            executionContext,
            logger: config.logger,
            permissionMode: config.permissionMode,
            hooks: {
              onBeforeToolExec: config.onBeforeToolExec,
            },
            onAfterToolExec: config.onAfterToolExec,
            onContentDelta: (delta) => {
              enqueueEvent({ type: 'content_delta', delta });
            },
            onThinkingDelta: (delta) => {
              enqueueEvent({ type: 'thinking_delta', delta });
            },
            onStreamEnd: () => {
              if (!signal?.aborted) {
                enqueueEvent({ type: 'stream_end' });
              }
            },
            onToolReady: (toolCall) => {
              const toolDef = executionPipeline.getRegistry().get(toolCall.function.name);
              const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
              enqueueEvent({ type: 'tool_start', toolCall, toolKind });
            },
            onToolComplete: (toolCall, result) => {
              enqueueEvent({ type: 'tool_result', toolCall, result });
            },
          })
          .then(({ chatResponse, executionResults }) => {
            turnResult = chatResponse;
            streamingExecutionResults = executionResults;
          })
          .catch((error: unknown) => {
            executionError = error;
          })
          .finally(() => {
            executionDone = true;
            flushWaiter();
          });

        while (!executionDone || pendingEvents.length > 0) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              waitForEventsResolve = resolve;
              if (pendingEvents.length > 0 || executionDone) {
                flushWaiter();
              }
            });
            continue;
          }

          while (pendingEvents.length > 0) {
            yield pendingEvents.shift()!;
          }
        }

        await executionPromise;

        if (executionError) {
          throw executionError;
        }
      } else if (streamHandler) {
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
      } else if (typeof chatService.chatWithRetryEvents === 'function') {
        // 使用 chatWithRetryEvents 以便 yield 重试事件
        const retryGen = chatService.chatWithRetryEvents(messages, tools, signal);
        while (true) {
          const { value, done } = await retryGen.next();
          if (done) {
            turnResult = value;
            break;
          }
          // RetryEvent → AgentEvent (api_retry)
          yield {
            type: 'api_retry',
            attempt: value.attempt,
            maxRetries: value.maxRetries,
            delayMs: value.delayMs,
            error: value.error,
          };
        }
      } else {
        turnResult = await chatService.chat(messages, tools, signal);
      }
    } catch (llmError) {
      // 模型 fallback 处理
      if (llmError instanceof FallbackTriggeredError) {
        yield {
          type: 'model_fallback',
          originalModel: llmError.originalModel,
          fallbackModel: llmError.fallbackModel,
        };
        // 让上层处理模型切换
        throw llmError;
      }

      if (
        isOverflowRecoverable(llmError)
        && config.onReactiveCompact
        && recoveryAttemptedTurn !== turnsCount
      ) {
        recoveryAttemptedTurn = turnsCount;
        yield { type: 'recovery', phase: 'started', reason: 'context_overflow' };
        const compactStream = config.onReactiveCompact({ messages });
        let recovered = false;
        while (true) {
          const { value, done } = await compactStream.next();
          if (done) {
            recovered = value;
            break;
          }
          yield value;
        }
        if (!recovered) {
          yield { type: 'recovery', phase: 'failed', reason: 'reactive_compact' };
          throw llmError;
        }
        yield { type: 'recovery', phase: 'retrying', reason: 'reactive_compact' };
        // Retry this turn
        turnsCount--;
        yield { type: 'turn_end', turn: turnsCount + 1, hasToolCalls: false };
        continue;
      }

      if (isOverflowRecoverable(llmError) && recoveryAttemptedTurn === turnsCount) {
        yield { type: 'recovery', phase: 'failed', reason: 'recovery_exhausted' };
      }
      throw llmError;
    }

    if (!turnResult) {
      throw new Error('Agent loop completed without a chat response');
    }

    recoveryAttemptedTurn = null;

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

    if (tokenBudget && turnResult.usage) {
      tokenBudget.record(turnResult.usage);

      if (tokenBudget.isWarning()) {
        yield { type: 'budget_warning', snapshot: tokenBudget.getSnapshot() };
      }

      if (tokenBudget.isApproachingLimit()) {
        yield { type: 'budget_warning', snapshot: tokenBudget.getSnapshot() };
      }

      if (tokenBudget.isDiminishingReturns()) {
        yield { type: 'agent_end' };
        return {
          success: false,
          error: {
            type: 'budget_exhausted',
            message: 'Stopped due to diminishing returns: consecutive turns produced very few tokens',
          },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
            tokenBudgetSnapshot: tokenBudget.getSnapshot(),
          },
        };
      }

      if (tokenBudget.isExhausted()) {
        yield { type: 'agent_end' };
        return {
          success: false,
          error: {
            type: 'budget_exhausted',
            message: 'Token budget exhausted',
          },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
            tokenBudgetSnapshot: tokenBudget.getSnapshot(),
          },
        };
      }
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
    if (turnResult.content?.trim() && !signal?.aborted && !streamingExecutionResults) {
      yield { type: 'stream_end' };
    }

    // 8. 检查是否有 tool calls
    if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
      const content = turnResult.content || '';
      const noToolDecision = await decideNoToolTurn(
        content,
        messages,
        turnsCount,
        config.onStopCheck,
      );
      if (noToolDecision.action === 'retry' || noToolDecision.action === 'continue_with_reminder') {
        messages.push(noToolDecision.message);
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        continue;
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
          tokenBudgetSnapshot: tokenBudget?.getSnapshot(),
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
    let executionResults = streamingExecutionResults;

    if (!executionResults) {
      const functionCalls = turnResult.toolCalls.filter(
        (tc): tc is FunctionToolCall => tc.type === 'function'
      );
      const executionPlan = planToolExecution(
        functionCalls,
        executionPipeline.getRegistry(),
        permissionMode,
      );

      // 发射 tool_start 事件
      for (const toolCall of executionPlan.calls) {
        const toolDef = executionPipeline.getRegistry().get(toolCall.function.name);
        const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
        yield { type: 'tool_start', toolCall, toolKind };
      }

      // 检查 abort
      if (signal?.aborted) {
        yield { type: 'agent_end' };
        return buildAbortResult(turnsCount, allToolResults.length, startTime);
      }

      executionResults = await executeToolCalls({
        plan: executionPlan,
        executionPipeline,
        executionContext,
        logger: config.logger,
        permissionMode: config.permissionMode,
        signal,
        hooks: {
          onBeforeToolExec: config.onBeforeToolExec,
        },
      });
    }

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      allToolResults.push(result);

      // 检查退出循环标记
      if (result.metadata?.shouldExitLoop) {
        const finalMessage =
          typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';
        if (!streamingExecutionResults) {
          yield { type: 'tool_result', toolCall, result };
        }
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

      if (!streamingExecutionResults) {
        yield { type: 'tool_result', toolCall, result };
      }

      // After-tool hook（JSONL 保存、模型切换等）
      if (!streamingExecutionResults) {
        await config.onAfterToolExec?.({ toolCall, result, toolUseUuid });
      }

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
      const limitDecision = await decideTurnLimit({
        maxTurns: config.maxTurns,
        turnsCount,
        messages,
        toolCallsCount: allToolResults.length,
        startTime,
        totalTokens,
        onTurnLimitReached: config.onTurnLimitReached,
        onTurnLimitCompact: config.onTurnLimitCompact,
      });
      if (limitDecision.action === 'stop') {
        yield { type: 'agent_end' };
        return limitDecision.result;
      }

      applyCompactionDecision(messages, limitDecision.compactedMessages, limitDecision.continueMessage);
      turnsCount = 0;
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

function applyCompactionDecision(
  messages: Message[],
  compactedMessages?: Message[],
  continueMessage?: Message,
): void {
  if (!compactedMessages) {
    return;
  }

  const systemMsg = messages.find((message) => message.role === 'system');
  messages.length = 0;
  if (systemMsg) {
    messages.push(systemMsg);
  }
  messages.push(...compactedMessages);
  if (continueMessage) {
    messages.push(continueMessage);
  }
}
