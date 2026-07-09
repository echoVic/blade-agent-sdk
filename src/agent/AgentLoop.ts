/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责循环骨架：调用 runTurn → 写消息 → 执行工具（非流式）→ 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 */

import type { InternalLogger } from '../logging/Logger.js';
import type { ChatResponse, Message, ToolCall } from '../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../tools/types/index.js';
import type { JsonObject } from '../types/common.js';
import type { AgentEvent } from './AgentEvent.js';
import {
  ExecutionEpoch,
  shouldStopAgentLoopToolResultProcessing,
} from './ExecutionEpoch.js';
import {
  createAgentRecoveryAttemptTracker,
  emitAgentRecoveryExhaustedEffectsIfAttempted,
  emitAgentRecoveryResetEffects,
  handleAgentReactiveCompactRecoveryWithEmissions,
} from './recoveryAttemptTracker.js';
import { handleAgentModelFallbackWithEmissions } from './recoveryEvents.js';
import {
  assertAgentLoopTurnResponse,
  handleAgentLoopAssistantMessage,
} from './loop/assistantMessage.js';
import {
  handleAgentLoopNoToolTurnWithEmissions,
  shouldHandleAgentLoopNoToolTurn,
} from './loop/decideNoToolTurn.js';
import {
  buildAgentLoopEffectiveMaxTurns,
  handleAgentLoopToolTurnTail,
} from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { buildAgentLoopStartEvent } from './loop/loopEvents.js';
import { emitAgentLoopResponseEventsFromTurnResult } from './loop/responseEvents.js';
import { createAgentLoopClock } from './loop/loopClock.js';
import {
  handleAgentLoopAbortIfRequested,
} from './loop/loopResult.js';
import {
  prepareAgentLoopNonStreamingToolExecution,
  shouldRunAgentLoopNonStreamingToolExecution,
} from './loop/planToolExecution.js';
import { runTurn } from './loop/runTurn.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import {
  emitAgentLoopTokenUsageEventIfPresent,
  handleAgentLoopTokenBudgetCheck,
} from './loop/tokenUsage.js';
import {
  createAgentLoopTokenUsageTracker,
} from './loop/tokenUsageTracker.js';
import {
  handleAgentLoopToolResult,
} from './loop/toolResultContinuation.js';
import { createAgentToolResultTracker } from './loop/toolResultTracker.js';
import { buildAgentLoopTurnStateProjectionFromPreparation } from './loop/turnState.js';
import {
  createAgentLoopTurnCounter,
  handleAgentLoopTurnStart,
  runAgentLoopBeforeTurnHook,
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

    const abortBeforeTurn = yield* handleAgentLoopAbortIfRequested({
      kind: 'counter_state',
      signal,
      loopClock,
      turnCounter,
      turnCountSource: 'current',
      toolResultTracker,
    });
    if (abortBeforeTurn.action === 'abort') {
      return abortBeforeTurn.result as LoopResult;
    }

    yield* runAgentLoopBeforeTurnHook({
      counter: turnCounter,
      conversation: convState,
      tokenUsageTracker,
      hooks,
    });

    const turnStart = handleAgentLoopTurnStart({
      counter: turnCounter,
      maxTurns: effectiveMaxTurns,
    });
    const turnsCount = turnStart.turn;
    for (const event of turnStart.events) {
      yield event;
    }

    const abortAfterTurnStart = yield* handleAgentLoopAbortIfRequested({
      kind: 'counter_state',
      signal,
      loopClock,
      turnCounter,
      turnCountSource: 'previous_completed',
      toolResultTracker,
    });
    if (abortAfterTurnStart.action === 'abort') {
      return abortAfterTurnStart.result as LoopResult;
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
      yield* handleAgentModelFallbackWithEmissions({
        error: llmError,
        epoch,
      });

      // 反应式压缩：context 溢出时尝试恢复
      const reactiveCompactRecovery = yield* handleAgentReactiveCompactRecoveryWithEmissions({
        error: llmError,
        tracker: recoveryAttemptTracker,
        turn: turnsCount,
        conversation: convState,
        hooks,
        epoch,
        counter: turnCounter,
      });
      if (reactiveCompactRecovery.action === 'failed') {
        throw llmError;
      }
      if (reactiveCompactRecovery.action === 'retry') {
        continue;
      }

      yield* emitAgentRecoveryExhaustedEffectsIfAttempted({
        error: llmError,
        turn: turnsCount,
        tracker: recoveryAttemptTracker,
        hooks,
      });
      throw llmError;
    }

    turnResult = assertAgentLoopTurnResponse(turnResult);

    yield* emitAgentRecoveryResetEffects({
      tracker: recoveryAttemptTracker,
      turn: turnsCount,
      hooks,
    });

    // Token usage
    yield* emitAgentLoopTokenUsageEventIfPresent({
      modelUsage: turnResult.usage,
      tokenUsageTracker,
      turnStateProjection,
    });

    const budgetCheck = yield* handleAgentLoopTokenBudgetCheck({
      tokenBudget,
      modelUsage: turnResult.usage,
      loopClock,
      turnsCount,
      toolResultTracker,
      tokenUsageTracker,
    });
    if (budgetCheck.action === 'stop') {
      return budgetCheck.result as LoopResult;
    }

    const abortAfterBudget = yield* handleAgentLoopAbortIfRequested({
      kind: 'counter_state',
      signal,
      loopClock,
      turnCounter,
      turnCountSource: 'previous_completed',
      toolResultTracker,
    });
    if (abortAfterBudget.action === 'abort') {
      return abortAfterBudget.result as LoopResult;
    }

    yield* emitAgentLoopResponseEventsFromTurnResult({
      response: turnResult,
      signal,
      streamingExecutionResults,
    });

    // 无 tool calls → 正常结束或重试
    if (shouldHandleAgentLoopNoToolTurn(turnResult)) {
      const noToolHandling = yield* handleAgentLoopNoToolTurnWithEmissions({
        response: turnResult,
        conversation: convState,
        turn: turnsCount,
        hooks,
        loopClock,
        toolResultTracker,
        tokenUsageTracker,
        tokenBudget,
      });
      if (noToolHandling.action === 'continue') {
        continue;
      }

      return noToolHandling.result as LoopResult;
    }

    await handleAgentLoopAssistantMessage({
      conversation: convState,
      response: turnResult,
      turn: turnsCount,
      hooks,
    });

    // 工具执行：流式已执行 or 非流式在此执行
    let executionResults = streamingExecutionResults;

    if (shouldRunAgentLoopNonStreamingToolExecution(executionResults)) {
      const nonStreamingToolExecution = prepareAgentLoopNonStreamingToolExecution({
        executionResults,
        response: turnResult,
        executionPipeline,
        turnStateProjection,
        logger: config.logger,
        signal,
        hooks,
      });

      for (const event of nonStreamingToolExecution.events) {
        yield event;
      }

      const abortBeforeToolExecution = yield* handleAgentLoopAbortIfRequested({
        kind: 'loop_state',
        signal,
        loopClock,
        turnsCount,
        toolResultTracker,
      });
      if (abortBeforeToolExecution.action === 'abort') {
        return abortBeforeToolExecution.result as LoopResult;
      }

      executionResults = await executeToolCalls(nonStreamingToolExecution.executeInput);
    }

    // 处理结果
    for (const { toolCall, result, toolUseUuid } of executionResults) {
      if (shouldStopAgentLoopToolResultProcessing(epoch)) break;

      const toolResultHandling = yield* handleAgentLoopToolResult({
        toolCall,
        result,
        toolUseUuid,
        streamingExecutionResults,
        loopClock,
        turnsCount,
        toolResultTracker,
        conversation: convState,
        hooks,
      });
      if (toolResultHandling.action === 'exit') {
        return toolResultHandling.exitDecision.result as LoopResult;
      }
    }

    const toolTurnTail = yield* handleAgentLoopToolTurnTail({
      signal,
      loopClock,
      turnsCount,
      maxTurns: config.maxTurns,
      effectiveMaxTurns,
      isYoloMode,
      conversation: convState,
      toolResultTracker,
      tokenUsageTracker,
      turnCounter,
      hooks,
    });
    if (toolTurnTail.action === 'abort' || toolTurnTail.action === 'stop') {
      return toolTurnTail.result as LoopResult;
    }
  }
}
