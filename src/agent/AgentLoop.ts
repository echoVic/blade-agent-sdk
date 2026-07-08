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
  buildAgentRecoveryExhaustedProjectionInputFromTracker,
  consumeAgentRecoveryResetAttempt,
  createAgentRecoveryAttemptTracker,
  hasAgentRecoveryAttemptExhausted,
  shouldAttemptAgentRecovery,
  startAgentRecoveryAttempt,
} from './recoveryAttemptTracker.js';
import {
  buildAgentModelFallbackEvent,
  buildAgentReactiveCompactHookPayloadFromConversation,
  buildAgentRecoveryEffects,
  buildAgentRecoveryProjectionInput,
  buildAgentRecoveryProjection,
  consumeAgentRecoveryCompactStream,
} from './recoveryEvents.js';
import {
  applyAgentLoopAssistantMessageProjection,
  assertAgentLoopTurnResponse,
  buildAgentLoopAssistantMessageProjection,
} from './loop/assistantMessage.js';
import {
  applyAgentLoopNoToolContinuation,
  buildAgentLoopNoToolContent,
  buildAgentLoopNoToolCompletePayload,
  buildAgentLoopNoToolContinuation,
  buildAgentLoopNoToolDecisionInputFromConversation,
  decideAgentLoopNoToolTurn,
  shouldContinueAgentLoopAfterNoToolDecision,
  shouldHandleAgentLoopNoToolTurn,
} from './loop/decideNoToolTurn.js';
import {
  applyAgentLoopTurnLimitContinuation,
  buildAgentLoopEffectiveMaxTurns,
  buildAgentLoopTurnLimitContinuation,
  buildAgentLoopTurnLimitDecisionInputFromLoopState,
  buildAgentLoopTurnLimitStopCompletion,
  decideTurnLimit,
  shouldApplyAgentLoopTurnLimitContinuation,
  shouldCheckAgentLoopTurnLimit,
  shouldStopAgentLoopForTurnLimitDecision,
} from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import {
  buildAgentLoopStartEvent,
  buildAgentLoopToolTurnCompletion,
  buildAgentLoopToolTurnCompletionInput,
  buildAgentLoopTurnRetryEvent,
  buildAgentLoopTurnRetryEventInput,
  buildAgentLoopTurnStartEvent,
  buildAgentLoopTurnStartEventInput,
} from './loop/loopEvents.js';
import {
  buildAgentLoopResponseEvents,
  buildAgentLoopResponseEventsInput,
} from './loop/responseEvents.js';
import { createAgentLoopClock } from './loop/loopClock.js';
import {
  buildAgentLoopAbortCompletion,
  buildAgentLoopAbortCompletionInputFromCounterState,
  buildAgentLoopAbortCompletionInputFromLoopState,
  buildAgentLoopNoToolSuccessDecision,
  buildAgentLoopNoToolSuccessDecisionInputFromLoopState,
  buildAgentLoopToolExitDecision,
  buildAgentLoopToolExitDecisionInputFromLoopState,
  shouldAbortAgentLoop,
  shouldExitAgentLoopForToolDecision,
} from './loop/loopResult.js';
import {
  buildAgentLoopExecuteToolCallsHooksInput,
  buildAgentLoopExecuteToolCallsInputFromTurnProjection,
  buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection,
  planAgentLoopToolExecution,
  selectAgentFunctionToolCalls,
  shouldRunAgentLoopNonStreamingToolExecution,
} from './loop/planToolExecution.js';
import { runTurn } from './loop/runTurn.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import {
  applyAgentLoopTokenBudget,
  buildAgentLoopTokenBudgetInputFromLoopState,
  buildAgentLoopTokenBudgetStopCompletion,
  buildAgentLoopTokenUsageEvent,
  buildAgentLoopTokenUsageInfo,
  buildAgentLoopTokenUsageInfoInputFromLoopState,
  shouldStopAgentLoopForTokenBudget,
} from './loop/tokenUsage.js';
import {
  createAgentLoopTokenUsageTracker,
  recordAgentLoopTokenUsage,
  shouldRecordAgentLoopTokenUsage,
} from './loop/tokenUsageTracker.js';
import {
  applyAgentLoopToolResultContinuation,
  buildAgentLoopAfterExecHookPayload,
  buildAgentLoopToolResultContinuation,
} from './loop/toolResultContinuation.js';
import {
  createAgentToolResultTracker,
  recordAgentToolResult,
} from './loop/toolResultTracker.js';
import {
  buildAgentLoopToolStartEvents,
  buildAgentLoopToolStartEventsInputFromExecutionPipeline,
} from './loop/toolStartEvent.js';
import { buildAgentLoopTurnStateProjectionFromPreparation } from './loop/turnState.js';
import {
  beginAgentLoopTurn,
  buildAgentLoopBeforeTurnHookPayloadFromLoopState,
  consumeAgentLoopBeforeTurnStream,
  createAgentLoopTurnCounter,
  requestAgentLoopTurnRetry,
  resetAgentLoopTurnCounter,
  shouldEmitAgentLoopTurnStart,
  shouldRunAgentLoopBeforeTurnHook,
} from './loop/turnCounter.js';
import {
  buildAgentLoopRunTurnInputFromLoopState,
  consumeAgentLoopTurnStream,
} from './loop/turnStream.js';
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
      const abortCompletion = buildAgentLoopAbortCompletion(
        buildAgentLoopAbortCompletionInputFromCounterState({
          loopClock,
          turnCounter,
          turnCountSource: 'current',
          toolResultTracker,
        }),
      );
      for (const event of abortCompletion.events) {
        yield event;
      }
      return abortCompletion.result;
    }

    const beforeTurnHook = turnHooks?.beforeTurn;
    if (shouldRunAgentLoopBeforeTurnHook(turnCounter, beforeTurnHook)) {
      const beforeTurnStream = beforeTurnHook(
        buildAgentLoopBeforeTurnHookPayloadFromLoopState({
          counter: turnCounter,
          conversation: convState,
          tokenUsageTracker,
        }),
      );
      yield* consumeAgentLoopBeforeTurnStream(beforeTurnStream);
    }

    const turnStart = beginAgentLoopTurn({ counter: turnCounter });
    const turnsCount = turnStart.turn;
    if (shouldEmitAgentLoopTurnStart(turnStart)) {
      yield buildAgentLoopTurnStartEvent(
        buildAgentLoopTurnStartEventInput({
          turn: turnsCount,
          maxTurns: effectiveMaxTurns,
        }),
      );
    }

    if (shouldAbortAgentLoop(signal)) {
      const abortCompletion = buildAgentLoopAbortCompletion(
        buildAgentLoopAbortCompletionInputFromCounterState({
          loopClock,
          turnCounter,
          turnCountSource: 'previous_completed',
          toolResultTracker,
        }),
      );
      for (const event of abortCompletion.events) {
        yield event;
      }
      return abortCompletion.result;
    }

    const turnStateProjection = buildAgentLoopTurnStateProjectionFromPreparation({
      prepareTurnState: config.prepareTurnState,
      turn: turnsCount,
    });

    // === runTurn：单回合 LLM 调用 + 流式事件 ===
    let turnResult: ChatResponse | undefined;
    let streamingExecutionResults: Array<{
      toolCall: FunctionToolCall;
      result: ToolResult;
      toolUseUuid: string | null;
    }> | undefined;

    try {
      const turnGen = runTurn(
        buildAgentLoopRunTurnInputFromLoopState({
          turnStateProjection,
          conversation: convState,
          executionPipeline,
          streaming,
          signal,
          epoch,
          logger: config.logger,
          hooks,
        }),
      );
      const turnStreamResult = yield* consumeAgentLoopTurnStream(turnGen);
      turnResult = turnStreamResult.turnResult;
      streamingExecutionResults = turnStreamResult.streamingExecutionResults;
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
        const recoveryAttempt = startAgentRecoveryAttempt({
          tracker: recoveryAttemptTracker,
          turn: turnsCount,
        });
        const recoveryStarted = buildAgentRecoveryProjection(
          buildAgentRecoveryProjectionInput({
            kind: 'started',
            turn: turnsCount,
            attempt: recoveryAttempt,
          }),
        );
        const recoveryStartedEffects = buildAgentRecoveryEffects(recoveryStarted);
        for (const stateChange of recoveryStartedEffects.stateChanges) {
          onRecoveryStateChange?.(stateChange);
        }
        for (const event of recoveryStartedEffects.events) {
          yield event;
        }
        const compactStream = reactiveCompact?.(
          buildAgentReactiveCompactHookPayloadFromConversation({ conversation: convState }),
        );
        if (!compactStream) {
          throw llmError;
        }
        const compactStreamResult = yield* consumeAgentRecoveryCompactStream(compactStream);
        if (!compactStreamResult.recovered) {
          const recoveryFailed = buildAgentRecoveryProjection(
            buildAgentRecoveryProjectionInput({
              kind: 'compact_failed',
              turn: turnsCount,
              attempt: recoveryAttempt,
            }),
          );
          const recoveryFailedEffects = buildAgentRecoveryEffects(recoveryFailed);
          for (const stateChange of recoveryFailedEffects.stateChanges) {
            onRecoveryStateChange?.(stateChange);
          }
          for (const event of recoveryFailedEffects.events) {
            yield event;
          }
          throw llmError;
        }
        const recoveryRetrying = buildAgentRecoveryProjection(
          buildAgentRecoveryProjectionInput({
            kind: 'retrying',
            turn: turnsCount,
            attempt: recoveryAttempt,
          }),
        );
        const recoveryRetryingEffects = buildAgentRecoveryEffects(recoveryRetrying);
        for (const stateChange of recoveryRetryingEffects.stateChanges) {
          onRecoveryStateChange?.(stateChange);
        }
        for (const event of recoveryRetryingEffects.events) {
          yield event;
        }
        epoch?.invalidate();
        // 显式"重试当前轮"：不减 turnsCount，不发 turn_end
        requestAgentLoopTurnRetry({ counter: turnCounter });
        yield buildAgentLoopTurnRetryEvent(
          buildAgentLoopTurnRetryEventInput({
            turn: turnsCount,
            reason: 'reactive_compact',
          }),
        );
        continue;
      }

      if (hasAgentRecoveryAttemptExhausted({
        error: llmError,
        tracker: recoveryAttemptTracker,
        turn: turnsCount,
      })) {
        const recoveryExhausted = buildAgentRecoveryProjection(
          buildAgentRecoveryExhaustedProjectionInputFromTracker({
            turn: turnsCount,
            tracker: recoveryAttemptTracker,
          }),
        );
        const recoveryExhaustedEffects = buildAgentRecoveryEffects(recoveryExhausted);
        for (const stateChange of recoveryExhaustedEffects.stateChanges) {
          recoveryHooks?.onStateChange?.(stateChange);
        }
        for (const event of recoveryExhaustedEffects.events) {
          yield event;
        }
      }
      throw llmError;
    }

    turnResult = assertAgentLoopTurnResponse(turnResult);

    if (consumeAgentRecoveryResetAttempt(recoveryAttemptTracker)) {
      const recoveryReset = buildAgentRecoveryProjection(
        buildAgentRecoveryProjectionInput({
          kind: 'reset',
          turn: turnsCount,
        }),
      );
      const recoveryResetEffects = buildAgentRecoveryEffects(recoveryReset);
      for (const stateChange of recoveryResetEffects.stateChanges) {
        recoveryHooks?.onStateChange?.(stateChange);
      }
    }

    // Token usage
    if (shouldRecordAgentLoopTokenUsage(turnResult.usage)) {
      recordAgentLoopTokenUsage({ tracker: tokenUsageTracker, usage: turnResult.usage });

      const usage = buildAgentLoopTokenUsageInfo(
        buildAgentLoopTokenUsageInfoInputFromLoopState({
          modelUsage: turnResult.usage,
          tokenUsageTracker,
          turnStateProjection,
        }),
      );
      yield buildAgentLoopTokenUsageEvent({ usage });
    }

    const budgetDecision = await applyAgentLoopTokenBudget(
      buildAgentLoopTokenBudgetInputFromLoopState({
        tokenBudget,
        modelUsage: turnResult.usage,
        loopClock,
        turnsCount,
        toolResultTracker,
        tokenUsageTracker,
      }),
    );
    if (shouldStopAgentLoopForTokenBudget(budgetDecision)) {
      const budgetStopCompletion = buildAgentLoopTokenBudgetStopCompletion(budgetDecision);
      for (const event of budgetStopCompletion.events) {
        yield event;
      }
      return budgetStopCompletion.result as LoopResult;
    }
    for (const budgetEvent of budgetDecision.events) {
      yield budgetEvent;
    }

    if (shouldAbortAgentLoop(signal)) {
      const abortCompletion = buildAgentLoopAbortCompletion(
        buildAgentLoopAbortCompletionInputFromCounterState({
          loopClock,
          turnCounter,
          turnCountSource: 'previous_completed',
          toolResultTracker,
        }),
      );
      for (const event of abortCompletion.events) {
        yield event;
      }
      return abortCompletion.result;
    }

    for (const responseEvent of buildAgentLoopResponseEvents(
      buildAgentLoopResponseEventsInput({
        response: turnResult,
        signal,
        streamingExecutionResults,
      }),
    )) {
      yield responseEvent;
    }

    // 无 tool calls → 正常结束或重试
    if (shouldHandleAgentLoopNoToolTurn(turnResult)) {
      const content = buildAgentLoopNoToolContent({ content: turnResult.content });
      const noToolDecision = await decideAgentLoopNoToolTurn(
        buildAgentLoopNoToolDecisionInputFromConversation({
          content,
          conversation: convState,
          turn: turnsCount,
          check: stopHooks?.check,
        }),
      );
      if (shouldContinueAgentLoopAfterNoToolDecision(noToolDecision)) {
        const noToolContinuation = applyAgentLoopNoToolContinuation({
          conversation: convState,
          continuation: buildAgentLoopNoToolContinuation({
            decision: noToolDecision,
            turn: turnsCount,
          }),
        });
        for (const event of noToolContinuation.events) {
          yield event;
        }
        continue;
      }

      await messageHooks?.onComplete?.(
        buildAgentLoopNoToolCompletePayload({ content, turn: turnsCount }),
      );

      const noToolSuccessDecision = buildAgentLoopNoToolSuccessDecision(
        buildAgentLoopNoToolSuccessDecisionInputFromLoopState({
          finalMessage: content,
          loopClock,
          turnsCount,
          toolResultTracker,
          tokenUsageTracker,
          tokenBudget,
        }),
      );
      for (const event of noToolSuccessDecision.events) {
        yield event;
      }
      return noToolSuccessDecision.result as LoopResult;
    }

    const assistantMessageProjection = applyAgentLoopAssistantMessageProjection({
      conversation: convState,
      projection: buildAgentLoopAssistantMessageProjection({
        response: turnResult,
        turn: turnsCount,
      }),
    });

    await messageHooks?.onAssistant?.(assistantMessageProjection.hookPayload);

    // 工具执行：流式已执行 or 非流式在此执行
    let executionResults = streamingExecutionResults;

    if (shouldRunAgentLoopNonStreamingToolExecution(executionResults)) {
      const functionCalls = selectAgentFunctionToolCalls(turnResult.toolCalls);
      const executionPlan = planAgentLoopToolExecution(
        buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection({
          calls: functionCalls,
          executionPipeline,
          turnStateProjection,
        }),
      );

      for (const event of buildAgentLoopToolStartEvents(
        buildAgentLoopToolStartEventsInputFromExecutionPipeline({
          plan: executionPlan,
          executionPipeline,
        }),
      )) {
        yield event;
      }

      if (shouldAbortAgentLoop(signal)) {
        const abortCompletion = buildAgentLoopAbortCompletion(
          buildAgentLoopAbortCompletionInputFromLoopState({
            loopClock,
            turnsCount,
            toolResultTracker,
          }),
        );
        for (const event of abortCompletion.events) {
          yield event;
        }
        return abortCompletion.result;
      }

      executionResults = await executeToolCalls(
        buildAgentLoopExecuteToolCallsInputFromTurnProjection({
          plan: executionPlan,
          executionPipeline,
          turnStateProjection,
          logger: config.logger,
          signal,
          hooks: buildAgentLoopExecuteToolCallsHooksInput({
            beforeExec: toolHooks?.beforeExec,
            onUpdate: toolHooks?.onUpdate,
          }),
        }),
      );
    }

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      if (shouldStopAgentLoopToolResultProcessing(epoch)) break;

      recordAgentToolResult({ tracker: toolResultTracker, result });

      const toolExitDecision = buildAgentLoopToolExitDecision(
        buildAgentLoopToolExitDecisionInputFromLoopState({
          toolCall,
          result,
          streamingExecutionResults,
          loopClock,
          turnsCount,
          toolResultTracker,
        }),
      );
      if (shouldExitAgentLoopForToolDecision(toolExitDecision)) {
        for (const event of toolExitDecision.events) {
          yield event;
        }
        return toolExitDecision.result as LoopResult;
      }

      const toolResultContinuation = buildAgentLoopToolResultContinuation({
        toolCall,
        result,
        streamingExecutionResults,
      });
      for (const event of toolResultContinuation.events) {
        yield event;
      }
      if (toolResultContinuation.shouldRunAfterExecHook) {
        await toolHooks?.afterExec?.(
          buildAgentLoopAfterExecHookPayload({ toolCall, result, toolUseUuid }),
        );
      }

      applyAgentLoopToolResultContinuation({
        conversation: convState,
        continuation: toolResultContinuation,
      });
    }

    const toolTurnCompletion = buildAgentLoopToolTurnCompletion(
      buildAgentLoopToolTurnCompletionInput({ turn: turnsCount }),
    );
    for (const event of toolTurnCompletion.events) {
      yield event;
    }

    if (shouldAbortAgentLoop(signal)) {
      const abortCompletion = buildAgentLoopAbortCompletion(
        buildAgentLoopAbortCompletionInputFromLoopState({
          loopClock,
          turnsCount,
          toolResultTracker,
        }),
      );
      for (const event of abortCompletion.events) {
        yield event;
      }
      return abortCompletion.result;
    }

    // 轮次上限
    if (shouldCheckAgentLoopTurnLimit({ turnsCount, effectiveMaxTurns, isYoloMode })) {
      const limitDecision = await decideTurnLimit(
        buildAgentLoopTurnLimitDecisionInputFromLoopState({
          maxTurns: config.maxTurns,
          turnsCount,
          conversation: convState,
          toolResultTracker,
          loopClock,
          tokenUsageTracker,
          hooks: turnHooks,
        }),
      );
      if (shouldStopAgentLoopForTurnLimitDecision(limitDecision)) {
        const turnLimitStopCompletion = buildAgentLoopTurnLimitStopCompletion(limitDecision);
        for (const event of turnLimitStopCompletion.events) {
          yield event;
        }
        return turnLimitStopCompletion.result;
      }

      const turnLimitContinuation = buildAgentLoopTurnLimitContinuation(limitDecision);
      if (shouldApplyAgentLoopTurnLimitContinuation(turnLimitContinuation)) {
        applyAgentLoopTurnLimitContinuation({
          conversation: convState,
          continuation: turnLimitContinuation,
        });
      }
      resetAgentLoopTurnCounter({ counter: turnCounter });
    }
  }
}
