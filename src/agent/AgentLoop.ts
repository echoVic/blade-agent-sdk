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
import {
  ExecutionEpoch,
  shouldStopAgentLoopToolResultProcessing,
} from './ExecutionEpoch.js';
import {
  consumeAgentRecoveryResetAttempt,
  createAgentRecoveryAttemptTracker,
  hasAgentRecoveryAttemptExhausted,
  shouldAttemptAgentRecovery,
} from './recoveryAttemptTracker.js';
import { buildAgentModelFallbackEvent, buildAgentRecoveryProjection } from './recoveryEvents.js';
import {
  assertAgentLoopTurnResponse,
  buildAgentLoopAssistantMessageProjection,
} from './loop/assistantMessage.js';
import {
  buildAgentLoopNoToolContent,
  decideNoToolTurn,
  shouldContinueAgentLoopAfterNoToolDecision,
  shouldHandleAgentLoopNoToolTurn,
} from './loop/decideNoToolTurn.js';
import {
  buildAgentLoopEffectiveMaxTurns,
  decideTurnLimit,
  shouldCheckAgentLoopTurnLimit,
} from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import {
  buildAgentLoopEndEvent,
  buildAgentLoopStartEvent,
  buildAgentLoopTurnEndEvent,
  buildAgentLoopTurnRetryEvent,
  buildAgentLoopTurnStartEvent,
} from './loop/loopEvents.js';
import { buildAgentLoopResponseEvents } from './loop/responseEvents.js';
import { createAgentLoopClock } from './loop/loopClock.js';
import {
  buildAgentLoopAbortResult,
  buildAgentLoopSuccessResult,
  buildAgentLoopToolExitDecision,
  shouldAbortAgentLoop,
  shouldExitAgentLoopForToolDecision,
} from './loop/loopResult.js';
import {
  planToolExecution,
  selectAgentFunctionToolCalls,
  shouldEmitAgentLoopNonStreamingToolResultEffects,
  shouldRunAgentLoopNonStreamingToolExecution,
} from './loop/planToolExecution.js';
import { runTurn } from './loop/runTurn.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import {
  applyAgentLoopTokenBudget,
  buildAgentLoopTokenUsageEvent,
  buildAgentLoopTokenUsageInfo,
  shouldStopAgentLoopForTokenBudget,
} from './loop/tokenUsage.js';
import {
  buildAgentLoopToolInjectedMessages,
  shouldAppendAgentLoopToolInjectedMessages,
} from './loop/toolInjectedMessages.js';
import {
  createAgentLoopTokenUsageTracker,
  shouldRecordAgentLoopTokenUsage,
} from './loop/tokenUsageTracker.js';
import { buildAgentLoopToolMessage } from './loop/toolMessage.js';
import { createAgentToolResultTracker } from './loop/toolResultTracker.js';
import { buildAgentLoopToolStartEvent } from './loop/toolStartEvent.js';
import { buildAgentLoopToolResultEvent } from './loop/toolUpdateToAgentEvent.js';
import { buildAgentLoopTurnStateProjection } from './loop/turnState.js';
import {
  createAgentLoopTurnCounter,
  shouldEmitAgentLoopTurnStart,
} from './loop/turnCounter.js';
import type { FunctionToolCall } from './loop/types.js';
import type { ConversationState } from './state/ConversationState.js';
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

  const effectiveMaxTurns = buildAgentLoopEffectiveMaxTurns({ maxTurns, isYoloMode });

  const loopClock = createAgentLoopClock();
  const turnCounter = createAgentLoopTurnCounter();
  const toolResultTracker = createAgentToolResultTracker<ToolResult>();
  const recoveryAttemptTracker = createAgentRecoveryAttemptTracker();
  const tokenUsageTracker = createAgentLoopTokenUsageTracker();
  let epoch: ExecutionEpoch | null = null;

  yield buildAgentLoopStartEvent();

  // === Agentic Loop ===
  while (true) {
    epoch = new ExecutionEpoch();

    if (shouldAbortAgentLoop(signal)) {
      yield buildAgentLoopEndEvent();
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
    if (shouldEmitAgentLoopTurnStart(turnStart)) {
      yield buildAgentLoopTurnStartEvent({ turn: turnsCount, maxTurns: effectiveMaxTurns });
    }

    if (shouldAbortAgentLoop(signal)) {
      yield buildAgentLoopEndEvent();
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount: turnCounter.previousCompletedTurnCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    const turnStateProjection = buildAgentLoopTurnStateProjection({
      turnState: config.prepareTurnState(turnsCount),
    });

    // === runTurn：单回合 LLM 调用 + 流式事件 ===
    let turnResult: ChatResponse | undefined;
    let streamingExecutionResults: Array<{
      toolCall: FunctionToolCall;
      result: ToolResult;
      toolUseUuid: string | null;
    }> | undefined;

    try {
      const turnGen = runTurn({
        turnState: turnStateProjection.turnState,
        messages: convState.toArray(),
        executionPipeline,
        streaming,
        signal,
        epoch,
        executionContext: turnStateProjection.executionContext,
        permissionMode: turnStateProjection.permissionMode,
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
        yield buildAgentModelFallbackEvent({
          originalModel: llmError.originalModel,
          fallbackModel: llmError.fallbackModel,
        });
        throw llmError;
      }

      // 反应式压缩：context 溢出时尝试恢复
      const reactiveCompact = recoveryHooks?.reactiveCompact;
      const onRecoveryStateChange = recoveryHooks?.onStateChange;
      if (shouldAttemptAgentRecovery({
        error: llmError,
        hasReactiveCompact: Boolean(reactiveCompact),
        tracker: recoveryAttemptTracker,
        turn: turnsCount,
      })) {
        const recoveryAttempt = recoveryAttemptTracker.startAttempt(turnsCount);
        const recoveryStarted = buildAgentRecoveryProjection({
          kind: 'started',
          turn: turnsCount,
          attempt: recoveryAttempt,
        });
        onRecoveryStateChange?.(recoveryStarted.stateChange);
        if (recoveryStarted.event) {
          yield recoveryStarted.event;
        }
        const compactStream = reactiveCompact?.({ messages: convState.toArray() });
        if (!compactStream) {
          throw llmError;
        }
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
          const recoveryFailed = buildAgentRecoveryProjection({
            kind: 'compact_failed',
            turn: turnsCount,
            attempt: recoveryAttempt,
          });
          onRecoveryStateChange?.(recoveryFailed.stateChange);
          if (recoveryFailed.event) {
            yield recoveryFailed.event;
          }
          throw llmError;
        }
        const recoveryRetrying = buildAgentRecoveryProjection({
          kind: 'retrying',
          turn: turnsCount,
          attempt: recoveryAttempt,
        });
        onRecoveryStateChange?.(recoveryRetrying.stateChange);
        if (recoveryRetrying.event) {
          yield recoveryRetrying.event;
        }
        epoch?.invalidate();
        // 显式"重试当前轮"：不减 turnsCount，不发 turn_end
        turnCounter.requestRetry();
        yield buildAgentLoopTurnRetryEvent({ turn: turnsCount, reason: 'reactive_compact' });
        continue;
      }

      if (hasAgentRecoveryAttemptExhausted({
        error: llmError,
        tracker: recoveryAttemptTracker,
        turn: turnsCount,
      })) {
        const recoveryExhausted = buildAgentRecoveryProjection({
          kind: 'exhausted',
          turn: turnsCount,
          attempt: recoveryAttemptTracker.attempt,
        });
        recoveryHooks?.onStateChange?.(recoveryExhausted.stateChange);
        if (recoveryExhausted.event) {
          yield recoveryExhausted.event;
        }
      }
      throw llmError;
    }

    turnResult = assertAgentLoopTurnResponse(turnResult);

    if (consumeAgentRecoveryResetAttempt(recoveryAttemptTracker)) {
      const recoveryReset = buildAgentRecoveryProjection({
        kind: 'reset',
        turn: turnsCount,
      });
      recoveryHooks?.onStateChange?.(recoveryReset.stateChange);
    }

    // Token usage
    if (shouldRecordAgentLoopTokenUsage(turnResult.usage)) {
      tokenUsageTracker.record(turnResult.usage);

      const usage = buildAgentLoopTokenUsageInfo({
        modelUsage: turnResult.usage,
        totalTokens: tokenUsageTracker.totalTokens,
        maxContextTokens: turnStateProjection.maxContextTokens,
      });
      yield buildAgentLoopTokenUsageEvent({ usage });
    }

    const budgetDecision = await applyAgentLoopTokenBudget({
      tokenBudget,
      modelUsage: turnResult.usage,
      tokensUsed: tokenUsageTracker.totalTokens,
      ...loopClock.resultTiming({
        turnsCount,
        toolCallsCount: toolResultTracker.toolCallsCount,
      }),
    });
    for (const budgetEvent of budgetDecision.events) {
      yield budgetEvent;
    }
    if (shouldStopAgentLoopForTokenBudget(budgetDecision)) {
      yield buildAgentLoopEndEvent();
      return budgetDecision.result as LoopResult;
    }

    if (shouldAbortAgentLoop(signal)) {
      yield buildAgentLoopEndEvent();
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount: turnCounter.previousCompletedTurnCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    for (const responseEvent of buildAgentLoopResponseEvents({
      reasoningContent: turnResult.reasoningContent,
      content: turnResult.content,
      aborted: Boolean(signal?.aborted),
      hasStreamingExecutionResults: streamingExecutionResults !== undefined,
    })) {
      yield responseEvent;
    }

    // 无 tool calls → 正常结束或重试
    if (shouldHandleAgentLoopNoToolTurn(turnResult)) {
      const content = buildAgentLoopNoToolContent({ content: turnResult.content });
      const noToolDecision = await decideNoToolTurn(
        content,
        convState.toArray(),
        turnsCount,
        stopHooks?.check,
      );
      if (shouldContinueAgentLoopAfterNoToolDecision(noToolDecision)) {
        convState.append(noToolDecision.message);
        yield buildAgentLoopTurnEndEvent({ turn: turnsCount, hasToolCalls: false });
        continue;
      }

      await messageHooks?.onComplete?.({ content, turn: turnsCount });

      yield buildAgentLoopTurnEndEvent({ turn: turnsCount, hasToolCalls: false });
      yield buildAgentLoopEndEvent();
      return buildAgentLoopSuccessResult({
        finalMessage: content,
        ...loopClock.resultTiming({
          turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
        tokensUsed: tokenUsageTracker.totalTokens,
        tokenBudgetSnapshot: tokenBudget?.getSnapshot(),
      }) as LoopResult;
    }

    const assistantMessageProjection = buildAgentLoopAssistantMessageProjection({
      response: turnResult,
      turn: turnsCount,
    });
    convState.append(assistantMessageProjection.message);

    await messageHooks?.onAssistant?.(assistantMessageProjection.hookPayload);

    // 工具执行：流式已执行 or 非流式在此执行
    let executionResults = streamingExecutionResults;

    if (shouldRunAgentLoopNonStreamingToolExecution(executionResults)) {
      const functionCalls = selectAgentFunctionToolCalls(turnResult.toolCalls);
      const executionPlan = planToolExecution(
        functionCalls,
        executionPipeline.getRegistry(),
        turnStateProjection.permissionMode,
      );

      for (const toolCall of executionPlan.calls) {
        yield buildAgentLoopToolStartEvent({
          toolCall,
          registry: executionPipeline.getRegistry(),
        });
      }

      if (shouldAbortAgentLoop(signal)) {
        yield buildAgentLoopEndEvent();
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
        executionContext: turnStateProjection.executionContext,
        logger: config.logger,
        permissionMode: turnStateProjection.permissionMode,
        signal,
        hooks: {
          onBeforeToolExec: toolHooks?.beforeExec,
          onUpdate: toolHooks?.onUpdate,
        },
      });
    }

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      if (shouldStopAgentLoopToolResultProcessing(epoch)) break;

      toolResultTracker.record(result);

      const toolExitDecision = buildAgentLoopToolExitDecision({
        toolCall,
        result,
        hasStreamingExecutionResults: streamingExecutionResults !== undefined,
        ...loopClock.resultTiming({
          turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
      if (shouldExitAgentLoopForToolDecision(toolExitDecision)) {
        for (const event of toolExitDecision.events) {
          yield event;
        }
        return toolExitDecision.result as LoopResult;
      }

      if (shouldEmitAgentLoopNonStreamingToolResultEffects(streamingExecutionResults)) {
        yield buildAgentLoopToolResultEvent({ toolCall, result });
        await toolHooks?.afterExec?.({ toolCall, result, toolUseUuid });
      }

      convState.append(buildAgentLoopToolMessage({ toolCall, result }));

      const injectedMessages = buildAgentLoopToolInjectedMessages({
        newMessages: result.newMessages,
      });
      if (shouldAppendAgentLoopToolInjectedMessages(injectedMessages)) {
        convState.append(...injectedMessages);
      }
    }

    yield buildAgentLoopTurnEndEvent({ turn: turnsCount, hasToolCalls: true });

    if (shouldAbortAgentLoop(signal)) {
      yield buildAgentLoopEndEvent();
      return buildAgentLoopAbortResult({
        ...loopClock.resultTiming({
          turnsCount,
          toolCallsCount: toolResultTracker.toolCallsCount,
        }),
      });
    }

    // 轮次上限
    if (shouldCheckAgentLoopTurnLimit({ turnsCount, effectiveMaxTurns, isYoloMode })) {
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
        yield buildAgentLoopEndEvent();
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
