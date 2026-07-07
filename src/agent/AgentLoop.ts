/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责循环骨架：调用 runTurn → 写消息 → 执行工具（非流式）→ 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 */

import type { InternalLogger } from '../logging/Logger.js';
import type { ChatResponse, Message, ToolCall } from '../services/ChatServiceInterface.js';
import { FallbackTriggeredError } from '../services/RetryPolicy.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../tools/types/index.js';
import type { JsonObject } from '../types/common.js';
import type { AgentEvent } from './AgentEvent.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import { ExecutionEpoch } from './ExecutionEpoch.js';
import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import { createAgentRecoveryAttemptTracker } from './recoveryAttemptTracker.js';
import { decideNoToolTurn } from './loop/decideNoToolTurn.js';
import { decideTurnLimit } from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { createAgentLoopClock } from './loop/loopClock.js';
import {
  buildAgentLoopAbortResult,
  buildAgentLoopBudgetExhaustedResult,
  buildAgentLoopSuccessResult,
  buildAgentLoopToolExitResult,
} from './loop/loopResult.js';
import { planToolExecution } from './loop/planToolExecution.js';
import { runTurn } from './loop/runTurn.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import { buildAgentLoopTokenUsageInfo } from './loop/tokenUsage.js';
import { createAgentLoopTokenUsageTracker } from './loop/tokenUsageTracker.js';
import { buildAgentToolResultContent } from './loop/toolResultContent.js';
import { createAgentToolResultTracker } from './loop/toolResultTracker.js';
import { createAgentLoopTurnCounter } from './loop/turnCounter.js';
import type { FunctionToolCall } from './loop/types.js';
import type { ConversationState } from './state/ConversationState.js';
import { markToolInjectedSystemMessages } from './state/toolInjectedMessages.js';
import type { TurnState } from './state/TurnState.js';
import type { TokenBudget } from './TokenBudget.js';
import type { LoopResult, TurnLimitResponse } from './types.js';

// ===== Loop 配置 =====

/**
 * 按阶段分组的 hook 接口。
 * LoopHookBuilder 负责构建，AgentLoop 消费。
 */
export interface AgentLoopHooks {
  turn?: {
    beforeTurn?: (ctx: {
      turn: number;
      messages: readonly Message[];
      lastPromptTokens?: number;
    }) => AsyncGenerator<AgentEvent, boolean>;
    onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
    onTurnLimitCompact?: (ctx: {
      contextMessages: readonly Message[];
    }) => Promise<{
      success: boolean;
      compactedMessages?: Message[];
      continueMessage?: Message;
    }>;
  };
  tool?: {
    beforeExec?: (ctx: {
      toolCall: FunctionToolCall;
      params: JsonObject;
    }) => Promise<string | null>;
    afterExec?: (ctx: {
      toolCall: FunctionToolCall;
      result: ToolResult;
      toolUseUuid: string | null;
    }) => Promise<void>;
    afterExecEpochDiscard?: (ctx: {
      toolCall: FunctionToolCall;
      toolUseUuid: string | null;
      reason: string;
    }) => Promise<void>;
    onUpdate?: (update: ToolExecutionUpdate) => Promise<void> | void;
  };
  message?: {
    onAssistant?: (ctx: {
      content: string;
      reasoningContent?: string;
      toolCalls?: ToolCall[];
      turn: number;
    }) => Promise<void>;
    onComplete?: (ctx: {
      content: string;
      turn: number;
    }) => Promise<void>;
  };
  recovery?: {
    reactiveCompact?: (ctx: {
      messages: readonly Message[];
    }) => AsyncGenerator<AgentEvent, boolean>;
    onStateChange?: (ctx: {
      turn: number;
      phase: 'started' | 'retrying' | 'failed' | 'reset';
      reason?: string;
      attempt: number;
    }) => void;
  };
  stop?: {
    check?: (ctx: {
      content: string;
      turn: number;
    }) => Promise<{ shouldStop: boolean; continueReason?: string; warning?: string }>;
  };
}

export interface AgentLoopConfig {
  streaming?: boolean;
  executionPipeline: ExecutionPipeline;
  logger?: InternalLogger;
  conversationState: ConversationState;
  maxTurns: number;
  isYoloMode: boolean;
  signal?: AbortSignal;
  tokenBudget?: TokenBudget;
  prepareTurnState: (turn: number) => TurnState;
  hooks?: AgentLoopHooks;
}

// ===== 核心循环 =====

export async function* agentLoop(
  config: AgentLoopConfig
): AsyncGenerator<AgentEvent, LoopResult> {
  const {
    streaming,
    executionPipeline,
    conversationState: convState,
    maxTurns,
    isYoloMode,
    signal,
    tokenBudget,
    hooks,
  } = config;

  const turnHooks = hooks?.turn;
  const toolHooks = hooks?.tool;
  const messageHooks = hooks?.message;
  const recoveryHooks = hooks?.recovery;
  const stopHooks = hooks?.stop;

  const effectiveMaxTurns = isYoloMode ? AGENT_TURN_SAFETY_LIMIT : maxTurns;

  const loopClock = createAgentLoopClock();
  const turnCounter = createAgentLoopTurnCounter();
  const toolResultTracker = createAgentToolResultTracker<ToolResult>();
  const recoveryAttemptTracker = createAgentRecoveryAttemptTracker();
  const tokenUsageTracker = createAgentLoopTokenUsageTracker();
  let epoch: ExecutionEpoch | null = null;

  yield { type: 'agent_start' };

  // === Agentic Loop ===
  while (true) {
    epoch = new ExecutionEpoch();

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount: turnCounter.turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    if (turnCounter.shouldRunBeforeTurn() && turnHooks?.beforeTurn) {
      const beforeTurnStream = turnHooks.beforeTurn({
        turn: turnCounter.turnsCount,
        messages: convState.toArray(),
        lastPromptTokens: tokenUsageTracker.lastPromptTokens,
      });
      while (true) {
        const { value, done } = await beforeTurnStream.next();
        if (done) break;
        yield value;
      }
    }

    const turnStart = turnCounter.beginTurn();
    const turnsCount = turnStart.turn;
    if (turnStart.started) {
      yield { type: 'turn_start', turn: turnsCount, maxTurns: effectiveMaxTurns };
    }

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount: turnCounter.previousCompletedTurnCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    const turnState = config.prepareTurnState(turnsCount);
    const _turnTools = turnState.tools;
    const turnMaxContextTokens = turnState.maxContextTokens;
    const turnPermissionMode = turnState.permissionMode;
    const turnExecutionContext = turnState.executionContext;

    // === runTurn：单回合 LLM 调用 + 流式事件 ===
    let turnResult: ChatResponse | undefined;
    let streamingExecutionResults: Array<{
      toolCall: FunctionToolCall;
      result: ToolResult;
      toolUseUuid: string | null;
    }> | undefined;

    try {
      const turnGen = runTurn({
        turnState,
        messages: convState.toArray(),
        executionPipeline,
        streaming,
        signal,
        epoch,
        executionContext: turnExecutionContext,
        permissionMode: turnPermissionMode,
        logger: config.logger,
        toolHooks: {
          onBeforeExec: toolHooks?.beforeExec,
          onAfterExec: toolHooks?.afterExec,
          onAfterExecEpochDiscard: toolHooks?.afterExecEpochDiscard,
          onUpdate: toolHooks?.onUpdate,
        },
      });
      while (true) {
        const { value, done } = await turnGen.next();
        if (done) {
          turnResult = value.chatResponse;
          streamingExecutionResults = value.streamingExecutionResults;
          break;
        }
        yield value;
      }
    } catch (llmError) {
      if (llmError instanceof FallbackTriggeredError) {
        epoch?.invalidate();
        yield {
          type: 'model_fallback',
          originalModel: llmError.originalModel,
          fallbackModel: llmError.fallbackModel,
        };
        throw llmError;
      }

      // 反应式压缩：context 溢出时尝试恢复
      if (
        isOverflowRecoverable(llmError)
        && recoveryHooks?.reactiveCompact
        && recoveryAttemptTracker.canAttempt(turnsCount)
      ) {
        const recoveryAttempt = recoveryAttemptTracker.startAttempt(turnsCount);
        recoveryHooks.onStateChange?.({
          turn: turnsCount,
          phase: 'started',
          reason: 'context_overflow',
          attempt: recoveryAttempt,
        });
        yield { type: 'recovery', phase: 'started', reason: 'context_overflow' };
        const compactStream = recoveryHooks.reactiveCompact({ messages: convState.toArray() });
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
          recoveryHooks.onStateChange?.({
            turn: turnsCount,
            phase: 'failed',
            reason: 'reactive_compact_failed',
            attempt: recoveryAttempt,
          });
          yield { type: 'recovery', phase: 'failed', reason: 'reactive_compact' };
          throw llmError;
        }
        recoveryHooks.onStateChange?.({
          turn: turnsCount,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: recoveryAttempt,
        });
        yield { type: 'recovery', phase: 'retrying', reason: 'reactive_compact' };
        epoch?.invalidate();
        // 显式"重试当前轮"：不减 turnsCount，不发 turn_end
        turnCounter.requestRetry();
        yield { type: 'turn_retry', turn: turnsCount, reason: 'reactive_compact' };
        continue;
      }

      if (isOverflowRecoverable(llmError) && recoveryAttemptTracker.hasAttemptedTurn(turnsCount)) {
        recoveryHooks?.onStateChange?.({
          turn: turnsCount,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: recoveryAttemptTracker.attempt,
        });
        yield { type: 'recovery', phase: 'failed', reason: 'recovery_exhausted' };
      }
      throw llmError;
    }

    if (!turnResult) {
      throw new Error('Agent loop completed without a chat response');
    }

    if (recoveryAttemptTracker.consumeResetAttempt() !== null) {
      recoveryHooks?.onStateChange?.({
        turn: turnsCount,
        phase: 'reset',
        attempt: 0,
      });
    }

    // Token usage
    if (turnResult.usage) {
      tokenUsageTracker.record(turnResult.usage);

      const usage = buildAgentLoopTokenUsageInfo({
        modelUsage: turnResult.usage,
        totalTokens: tokenUsageTracker.totalTokens,
        maxContextTokens: turnMaxContextTokens,
      });
      yield { type: 'token_usage', usage };
    }

    if (tokenBudget && turnResult.usage) {
      tokenBudget.record(turnResult.usage);

      if (tokenBudget.isWarning() || tokenBudget.isApproachingLimit()) {
        yield { type: 'budget_warning', snapshot: tokenBudget.getSnapshot() };
      }

      if (tokenBudget.isDiminishingReturns()) {
        yield { type: 'agent_end' };
        return buildAgentLoopBudgetExhaustedResult({
          reason: 'diminishing_returns',
          ...loopClock.resultTiming({
            turnsCount,
            toolCallsCount: toolResultTracker.toolCallsCount,
          }),
          tokensUsed: tokenUsageTracker.totalTokens,
          tokenBudgetSnapshot: tokenBudget.getSnapshot(),
        }) as LoopResult;
      }

      if (tokenBudget.isExhausted()) {
        yield { type: 'agent_end' };
        return buildAgentLoopBudgetExhaustedResult({
          reason: 'exhausted',
          ...loopClock.resultTiming({
            turnsCount,
            toolCallsCount: toolResultTracker.toolCallsCount,
          }),
          tokensUsed: tokenUsageTracker.totalTokens,
          tokenBudgetSnapshot: tokenBudget.getSnapshot(),
        }) as LoopResult;
      }
    }

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount: turnCounter.previousCompletedTurnCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    if (turnResult.reasoningContent && !signal?.aborted) {
      yield { type: 'thinking', content: turnResult.reasoningContent };
    }

    if (turnResult.content?.trim() && !signal?.aborted && !streamingExecutionResults) {
      yield { type: 'stream_end' };
    }

    // 无 tool calls → 正常结束或重试
    if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
      const content = turnResult.content || '';
      const noToolDecision = await decideNoToolTurn(
        content,
        convState.toArray(),
        turnsCount,
        stopHooks?.check,
      );
      if (noToolDecision.action === 'retry' || noToolDecision.action === 'continue_with_reminder') {
        convState.append(noToolDecision.message);
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        continue;
      }

      await messageHooks?.onComplete?.({ content, turn: turnsCount });

      yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
      yield { type: 'agent_end' };
      return buildAgentLoopSuccessResult({
        finalMessage: turnResult.content,
        ...loopClock.resultTiming({
          turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
        tokensUsed: tokenUsageTracker.totalTokens,
        tokenBudgetSnapshot: tokenBudget?.getSnapshot(),
      }) as LoopResult;
    }

    // 写入 assistant 消息
    convState.append({
      role: 'assistant',
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      tool_calls: turnResult.toolCalls,
    });

    await messageHooks?.onAssistant?.({
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      toolCalls: turnResult.toolCalls,
      turn: turnsCount,
    });

    // 工具执行：流式已执行 or 非流式在此执行
    let executionResults = streamingExecutionResults;

    if (!executionResults) {
      const functionCalls = turnResult.toolCalls.filter(
        (tc): tc is FunctionToolCall => tc.type === 'function',
      );
      const executionPlan = planToolExecution(
        functionCalls,
        executionPipeline.getRegistry(),
        turnPermissionMode,
      );

      for (const toolCall of executionPlan.calls) {
        const toolDef = executionPipeline.getRegistry().get(toolCall.function.name);
        const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
        yield { type: 'tool_start', toolCall, toolKind };
      }

      if (signal?.aborted) {
        yield { type: 'agent_end' };
        return buildAgentLoopAbortResult({
          ...loopClock.resultTiming({
            turnsCount,
            toolCallsCount: toolResultTracker.toolCallsCount,
          }),
        });
      }

      executionResults = await executeToolCalls({
        plan: executionPlan,
        executionPipeline,
        executionContext: turnExecutionContext,
        logger: config.logger,
        permissionMode: turnPermissionMode,
        signal,
        hooks: {
          onBeforeToolExec: toolHooks?.beforeExec,
          onUpdate: toolHooks?.onUpdate,
        },
      });
    }

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      if (epoch && !epoch.isValid) break;

      toolResultTracker.record(result);

      if (result.metadata?.shouldExitLoop) {
        const finalMessage =
          typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';
        if (!streamingExecutionResults) {
          yield { type: 'tool_result', toolCall, result };
        }
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: true };
        yield { type: 'agent_end' };
        return buildAgentLoopToolExitResult({
          success: result.success,
          finalMessage,
          ...loopClock.resultTiming({
            turnsCount,
            toolCallsCount: toolResultTracker.toolCallsCount,
          }),
          targetMode: result.metadata?.targetMode,
        }) as LoopResult;
      }

      if (!streamingExecutionResults) {
        yield { type: 'tool_result', toolCall, result };
        await toolHooks?.afterExec?.({ toolCall, result, toolUseUuid });
      }

      convState.append({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: buildAgentToolResultContent(result),
      });

      if (result.newMessages && result.newMessages.length > 0) {
        convState.append(...markToolInjectedSystemMessages(result.newMessages));
      }
    }

    yield { type: 'turn_end', turn: turnsCount, hasToolCalls: true };

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    // 轮次上限
    if (turnsCount >= effectiveMaxTurns && !isYoloMode) {
      const limitDecision = await decideTurnLimit({
        maxTurns: config.maxTurns,
        turnsCount,
        contextMessages: convState.getContextMessages(),
        toolCallsCount: toolResultTracker.toolCallsCount,
        startTime: loopClock.startTime,
        totalTokens: tokenUsageTracker.totalTokens,
        onTurnLimitReached: turnHooks?.onTurnLimitReached,
        onTurnLimitCompact: turnHooks?.onTurnLimitCompact,
      });
      if (limitDecision.action === 'stop') {
        yield { type: 'agent_end' };
        return limitDecision.result;
      }

      if (limitDecision.compactedMessages) {
        convState.replaceContent(limitDecision.compactedMessages);
        if (limitDecision.continueMessage) {
          convState.append(limitDecision.continueMessage);
        }
      }
      turnCounter.reset();
    }
  }
}
