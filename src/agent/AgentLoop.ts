/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责循环骨架：调用 runTurn → 写消息 → 执行工具（非流式）→ 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 */

import { isHookProcessContainmentError } from '../hooks/WindowsProcessJob.js';
import type { InternalLogger } from '../logging/Logger.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelIdentity } from '../model/identity.js';
import type { ModelToolCall } from '../model/message.js';
import type { ModelResponse } from '../model/service.js';
import type { TokenUsage } from '../model/usage.js';
import { normalizeModelUsage } from '../model/usage.js';
import { FallbackTriggeredError } from '../services/RetryPolicy.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolEffect } from '../tools/types/effects.js';
import type { ToolResult } from '../tools/types/result.js';
import { getSteeringInterruptInputId } from '../types/abort.js';
import type { PermissionMode } from '../types/constants.js';
import type { MessageId, ModelAttemptId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentEvent } from './AgentEvent.js';
import type { AgentRunControl, AgentSteeringInput } from './AgentRunControl.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import { ExecutionEpoch } from './ExecutionEpoch.js';
import {
  type InitialInputPreparation,
  RECONCILED_INITIAL_INPUT,
} from './InitialInputPreparation.js';
import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import { decideNoToolTurn } from './loop/decideNoToolTurn.js';
import { decideTurnLimit } from './loop/decideTurnLimit.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { planToolExecution } from './loop/planToolExecution.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import { runTurn } from './loop/runTurn.js';
import type { ModelExecutionLifecycle } from './ModelExecutionLifecycle.js';
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
  input?: {
    beforeApply?: (ctx: { input: AgentSteeringInput; turn: number }) => Promise<void>;
    apply?: (ctx: { input: AgentSteeringInput; turn: number }) => Promise<ConversationMessage>;
  };
  turn?: {
    beforeTurn?: (ctx: {
      turn: number;
      messages: readonly ConversationMessage[];
      lastPromptTokens?: number;
    }) => AsyncGenerator<AgentEvent, boolean>;
    onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
    onTurnLimitCompact?: (ctx: { contextMessages: readonly ConversationMessage[] }) => Promise<{
      success: boolean;
      compactedMessages?: ConversationMessage[];
      continueMessage?: ConversationMessage;
    }>;
  };
  tool?: {
    beforeExec?: (ctx: {
      toolCall: ModelToolCall;
      params: JsonObject;
    }) => Promise<MessageId | null>;
    afterExec?: (ctx: {
      toolCall: ModelToolCall;
      result: ToolResult;
      effects: ToolEffect[];
      toolMessageId: MessageId | null;
    }) => Promise<void>;
    afterExecEpochDiscard?: (ctx: {
      toolCall: ModelToolCall;
      toolMessageId: MessageId | null;
      reason: string;
    }) => Promise<void>;
    onUpdate?: (update: ToolExecutionUpdate) => Promise<void> | void;
  };
  message?: {
    onAssistant?: (ctx: {
      content: string;
      reasoningContent?: string;
      toolCalls?: ModelToolCall[];
      modelIdentity: ModelIdentity;
      turn: number;
    }) => Promise<void>;
    onComplete?: (ctx: { content: string; turn: number }) => Promise<void>;
  };
  recovery?: {
    reactiveCompact?: (ctx: {
      messages: readonly ConversationMessage[];
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
  runControl?: AgentRunControl;
  modelExecutionLifecycle?: ModelExecutionLifecycle;
  initialInputPreparation?: InitialInputPreparation;
  prepareTurnState: (turn: number) => TurnState;
  hooks?: AgentLoopHooks;
}

// ===== 核心循环 =====

export async function* agentLoop(config: AgentLoopConfig): AsyncGenerator<AgentEvent, LoopResult> {
  const {
    streaming,
    executionPipeline,
    conversationState: convState,
    maxTurns,
    isYoloMode,
    signal,
    tokenBudget,
    runControl,
    modelExecutionLifecycle,
    initialInputPreparation,
    hooks,
  } = config;
  const inputHooks = hooks?.input;

  const turnHooks = hooks?.turn;
  const toolHooks = hooks?.tool;
  const messageHooks = hooks?.message;
  const recoveryHooks = hooks?.recovery;
  const stopHooks = hooks?.stop;

  const effectiveMaxTurns = isYoloMode ? AGENT_TURN_SAFETY_LIMIT : maxTurns;

  const startTime = Date.now();
  // turnsCount is the current max-turn window; totalTurnsCount is never reset.
  let turnsCount = 0;
  let totalTurnsCount = 0;
  /** 轮式环形缓冲：只保留最近 N 条工具结果（AgentLoop 观察用，不影响外部） */
  const TOOL_RESULT_BUFFER = 50;
  const recentToolResults: ToolResult[] = [];
  let totalToolCalls = 0;
  let totalTokens = 0;
  let lastPromptTokens: number | undefined;
  /**
   * 反应式压缩恢复状态机：
   * - idle: 未在恢复中
   * - retry_pending: 压缩成功，当前轮待重试（跳过 beforeTurn/turn_start/turnsCount）
   * - in_retried_turn: 已消费重试，正在执行重试轮（再次溢出则判定 exhausted）
   */
  type RecoveryState =
    | { phase: 'idle' }
    | { phase: 'retry_pending'; turn: number; attempt: number }
    | { phase: 'in_retried_turn'; turn: number; attempt: number };
  let recovery: RecoveryState = { phase: 'idle' };
  let epoch: ExecutionEpoch | null = null;

  const recordToolResult = (result: ToolResult): void => {
    totalToolCalls += 1;
    recentToolResults.push(result);
    if (recentToolResults.length > TOOL_RESULT_BUFFER) {
      recentToolResults.shift();
    }
  };

  yield { type: 'agent_start' };

  // === Agentic Loop ===
  while (true) {
    epoch = new ExecutionEpoch();
    runControl?.advanceStep();

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(totalTurnsCount, totalToolCalls, startTime);
    }

    yield* applyPendingSteeringInputs({
      runControl,
      inputHooks,
      conversationState: convState,
      turn: turnsCount + 1,
      includeNow: true,
    });

    if (
      recovery.phase !== 'retry_pending' &&
      !(initialInputPreparation === RECONCILED_INITIAL_INPUT && totalTurnsCount === 0) &&
      turnHooks?.beforeTurn
    ) {
      yield* turnHooks.beforeTurn({
        turn: turnsCount,
        messages: convState.toArray(),
        lastPromptTokens,
      });
    }

    if (recovery.phase !== 'retry_pending') {
      turnsCount++;
      totalTurnsCount++;
      yield { type: 'turn_start', turn: turnsCount, maxTurns: effectiveMaxTurns };
    }
    // 消费重试标记：retry_pending -> in_retried_turn
    if (recovery.phase === 'retry_pending') {
      recovery = {
        phase: 'in_retried_turn',
        turn: recovery.turn,
        attempt: recovery.attempt,
      };
    }

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(totalTurnsCount - 1, totalToolCalls, startTime);
    }

    const turnState = config.prepareTurnState(turnsCount);
    const _turnTools = turnState.tools;
    const turnMaxContextTokens = turnState.maxContextTokens;
    const turnPermissionMode = turnState.permissionMode;
    const turnExecutionContext = turnState.executionContext;

    // === runTurn：单回合 LLM 调用 + 流式事件 ===
    let turnResult: ModelResponse | undefined;
    let modelIdentity: ModelIdentity | undefined;
    let streamingExecutionResults:
      | Array<{
          toolCall: ModelToolCall;
          result: ToolResult;
          effects: ToolEffect[];
          toolMessageId: MessageId | null;
        }>
      | undefined;
    let modelAttemptId: ModelAttemptId | undefined;

    const stepSignal = runControl?.stepSignal ?? signal;
    try {
      const turnOutcome = yield* runTurn({
        turnState,
        messages: convState.toArray(),
        executionPipeline,
        streaming,
        signal: stepSignal,
        requestSignal: signal,
        steeringSignal: runControl?.steeringSignal,
        epoch,
        executionContext: turnExecutionContext,
        permissionMode: turnPermissionMode,
        modelExecutionLifecycle,
        logger: config.logger,
        toolHooks: {
          onBeforeExec: toolHooks?.beforeExec,
          onAfterExec: toolHooks?.afterExec,
          onAfterExecEpochDiscard: toolHooks?.afterExecEpochDiscard,
          onUpdate: toolHooks?.onUpdate,
        },
      });
      turnResult = turnOutcome.chatResponse;
      modelIdentity = turnOutcome.modelIdentity;
      streamingExecutionResults = turnOutcome.streamingExecutionResults;
      modelAttemptId = turnOutcome.modelAttemptId;
    } catch (llmError) {
      if (isHookProcessContainmentError(llmError)) {
        throw llmError;
      }
      const interruptInputId = getSteeringInterruptInputId(stepSignal);
      if (!signal?.aborted && interruptInputId && runControl) {
        yield {
          type: 'turn_interrupted',
          inputId: interruptInputId,
          requestId: runControl.requestId,
          turn: turnsCount,
        };
        yield* applyPendingSteeringInputs({
          runControl,
          inputHooks,
          conversationState: convState,
          turn: turnsCount + 1,
          includeNow: true,
        });
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        continue;
      }
      if (llmError instanceof FallbackTriggeredError) {
        epoch?.invalidate();
        yield {
          type: 'model_fallback',
          originalModel: llmError.originalModel,
          fallbackModel: llmError.fallbackModel,
        };
        throw llmError;
      }

      // 反应式压缩：context 溢出时尝试恢复（仅从 idle 状态发起）
      if (
        isOverflowRecoverable(llmError) &&
        recoveryHooks?.reactiveCompact &&
        recovery.phase === 'idle'
      ) {
        const attempt = 1;
        recovery = { phase: 'retry_pending', turn: turnsCount, attempt };
        recoveryHooks.onStateChange?.({
          turn: turnsCount,
          phase: 'started',
          reason: 'context_overflow',
          attempt,
        });
        yield { type: 'recovery', phase: 'started', reason: 'context_overflow' };
        const recovered = yield* recoveryHooks.reactiveCompact({
          messages: convState.toArray(),
        });
        if (!recovered) {
          recoveryHooks.onStateChange?.({
            turn: turnsCount,
            phase: 'failed',
            reason: 'reactive_compact_failed',
            attempt,
          });
          yield { type: 'recovery', phase: 'failed', reason: 'reactive_compact' };
          throw llmError;
        }
        recoveryHooks.onStateChange?.({
          turn: turnsCount,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt,
        });
        yield { type: 'recovery', phase: 'retrying', reason: 'reactive_compact' };
        epoch?.invalidate();
        // 显式"重试当前轮"：不减 turnsCount，不发 turn_end
        yield { type: 'turn_retry', turn: turnsCount, reason: 'reactive_compact' };
        continue;
      }

      if (isOverflowRecoverable(llmError) && recovery.phase === 'in_retried_turn') {
        recoveryHooks?.onStateChange?.({
          turn: turnsCount,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: recovery.attempt,
        });
        yield { type: 'recovery', phase: 'failed', reason: 'recovery_exhausted' };
      }
      throw llmError;
    }

    if (!turnResult || !modelIdentity) {
      throw new Error('Agent loop completed without a chat response and model identity');
    }

    if (recovery.phase !== 'idle') {
      recoveryHooks?.onStateChange?.({
        turn: turnsCount,
        phase: 'reset',
        attempt: 0,
      });
      recovery = { phase: 'idle' };
    }

    // Token usage
    if (turnResult.usage) {
      if (turnResult.usage.totalTokens) {
        totalTokens += turnResult.usage.totalTokens;
      }
      lastPromptTokens = turnResult.usage.promptTokens;

      const usage: TokenUsage = normalizeModelUsage(
        turnResult.usage,
        turnMaxContextTokens,
        totalTokens,
      );
      yield { type: 'token_usage', usage };
    }

    if (tokenBudget && turnResult.usage) {
      tokenBudget.record(turnResult.usage);

      if (tokenBudget.isWarning() || tokenBudget.isApproachingLimit()) {
        yield { type: 'budget_warning', snapshot: tokenBudget.getSnapshot() };
      }

      if (tokenBudget.isDiminishingReturns()) {
        yield { type: 'agent_end' };
        return {
          success: false,
          error: {
            type: 'budget_exhausted',
            message:
              'Stopped due to diminishing returns: consecutive turns produced very few tokens',
          },
          metadata: {
            turnsCount: totalTurnsCount,
            toolCallsCount: totalToolCalls,
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
            turnsCount: totalTurnsCount,
            toolCallsCount: totalToolCalls,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
            tokenBudgetSnapshot: tokenBudget.getSnapshot(),
          },
        };
      }
    }

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(totalTurnsCount - 1, totalToolCalls, startTime);
    }

    const steeringInterruptInputId = getSteeringInterruptInputId(stepSignal);

    if (turnResult.reasoningContent && !signal?.aborted && !steeringInterruptInputId) {
      yield { type: 'thinking', content: turnResult.reasoningContent };
    }

    if (
      turnResult.content?.trim() &&
      !signal?.aborted &&
      !steeringInterruptInputId &&
      !streamingExecutionResults
    ) {
      yield { type: 'stream_end' };
    }

    // 无 tool calls → 正常结束或重试
    if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
      const content = turnResult.content || '';
      if (!steeringInterruptInputId) {
        convState.append({
          role: 'assistant',
          content,
          reasoningContent: turnResult.reasoningContent,
          modelIdentity,
        });
        await messageHooks?.onAssistant?.({
          content,
          reasoningContent: turnResult.reasoningContent,
          modelIdentity,
          turn: turnsCount,
        });
      }

      if (!signal?.aborted && steeringInterruptInputId && runControl) {
        yield {
          type: 'turn_interrupted',
          inputId: steeringInterruptInputId,
          requestId: runControl.requestId,
          turn: turnsCount,
        };
      }
      const pendingBeforeDecision =
        runControl?.claimSteeringInputs({
          includeNow: true,
        }) ?? [];
      if (pendingBeforeDecision.length > 0) {
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        yield* applyClaimedSteeringInputs({
          inputs: pendingBeforeDecision,
          runControl,
          inputHooks,
          conversationState: convState,
          turn: turnsCount + 1,
        });
        continue;
      }

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

      const completionInterruptInputId = getSteeringInterruptInputId(stepSignal);
      if (
        !steeringInterruptInputId &&
        !signal?.aborted &&
        completionInterruptInputId &&
        runControl
      ) {
        yield {
          type: 'turn_interrupted',
          inputId: completionInterruptInputId,
          requestId: runControl.requestId,
          turn: turnsCount,
        };
      }
      const pendingAtCompletion =
        runControl?.claimSteeringInputs({
          includeNow: true,
          sealIfEmpty: true,
        }) ?? [];
      if (pendingAtCompletion.length > 0) {
        yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
        yield* applyClaimedSteeringInputs({
          inputs: pendingAtCompletion,
          runControl,
          inputHooks,
          conversationState: convState,
          turn: turnsCount + 1,
        });
        continue;
      }

      await messageHooks?.onComplete?.({ content, turn: turnsCount });

      yield { type: 'turn_end', turn: turnsCount, hasToolCalls: false };
      yield { type: 'agent_end' };
      return {
        success: true,
        finalMessage: turnResult.content,
        metadata: {
          turnsCount: totalTurnsCount,
          toolCallsCount: totalToolCalls,
          duration: Date.now() - startTime,
          tokensUsed: totalTokens,
          tokenBudgetSnapshot: tokenBudget?.getSnapshot(),
        },
      };
    }

    // 工具执行：流式已执行 or 非流式在此执行
    let executionResults = streamingExecutionResults;

    if (!executionResults) {
      const functionCalls = turnResult.toolCalls.filter(
        (tc): tc is ModelToolCall => tc.type === 'function',
      );
      const executionPlan = planToolExecution(functionCalls, turnPermissionMode);

      for (const toolCall of executionPlan.calls) {
        const toolDef = executionPipeline.getRegistry().get(toolCall.function.name);
        const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
        yield { type: 'tool_start', toolCall, toolKind };
      }

      if (signal?.aborted) {
        yield { type: 'agent_end' };
        return buildAbortResult(totalTurnsCount, totalToolCalls, startTime);
      }

      executionResults = await executeToolCalls({
        plan: executionPlan,
        executionPipeline,
        executionContext: modelAttemptId
          ? { ...turnExecutionContext, modelAttemptId }
          : turnExecutionContext,
        logger: config.logger,
        permissionMode: turnPermissionMode,
        signal,
        steeringSignal: runControl?.steeringSignal,
        hooks: {
          onBeforeToolExec: toolHooks?.beforeExec,
          onUpdate: toolHooks?.onUpdate,
        },
      });
    }

    const resultByToolCallId = new Map(
      executionResults.map((executionResult) => [executionResult.toolCall.id, executionResult]),
    );
    const orderedExecutionResults = turnResult.toolCalls.flatMap((toolCall) => {
      const executionResult = resultByToolCallId.get(toolCall.id);
      return executionResult ? [executionResult] : [];
    });

    if (epoch && !epoch.isValid) {
      for (const { toolCall, toolMessageId } of orderedExecutionResults) {
        await toolHooks?.afterExecEpochDiscard?.({
          toolCall,
          toolMessageId,
          reason: 'execution epoch invalidated',
        });
      }
      continue;
    }

    if (orderedExecutionResults.length !== turnResult.toolCalls.length) {
      const missing = turnResult.toolCalls
        .filter((toolCall) => !resultByToolCallId.has(toolCall.id))
        .map((toolCall) => `${toolCall.function.name}(${toolCall.id})`);
      throw new Error(
        `Tool execution completed without results for every declared tool call: ${missing.join(', ')}`,
      );
    }

    // Persist the assistant declaration before any tool results in both
    // streaming and non-streaming modes.
    convState.append({
      role: 'assistant',
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      tool_calls: turnResult.toolCalls,
      modelIdentity,
    });

    await messageHooks?.onAssistant?.({
      content: turnResult.content || '',
      reasoningContent: turnResult.reasoningContent,
      toolCalls: turnResult.toolCalls,
      modelIdentity,
      turn: turnsCount,
    });

    let exitResult: (typeof orderedExecutionResults)[number] | undefined;
    // 处理结果
    for (const { toolCall, result, effects, toolMessageId } of orderedExecutionResults) {
      recordToolResult(result);

      if (result.metadata?.shouldExitLoop && !exitResult) {
        exitResult = { toolCall, result, effects, toolMessageId };
      }

      if (!streamingExecutionResults) {
        yield { type: 'tool_result', toolCall, result };
      }
      await toolHooks?.afterExec?.({ toolCall, result, effects, toolMessageId });

      // 写入 tool 消息
      let toolResultContent = result.model;

      if (typeof toolResultContent === 'object' && toolResultContent !== null) {
        toolResultContent = JSON.stringify(toolResultContent, null, 2);
      }

      convState.append({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content:
          typeof toolResultContent === 'string'
            ? toolResultContent
            : JSON.stringify(toolResultContent),
      });
    }

    for (const { effects } of orderedExecutionResults) {
      const newMessages = effects
        .filter((effect) => effect.type === 'newMessages')
        .flatMap((effect) => (effect.type === 'newMessages' ? effect.messages : []));
      if (newMessages.length > 0) {
        convState.append(
          ...newMessages.map((message) => ({
            ...message,
            ...(message.role === 'system'
              ? {
                  provenance: {
                    source: 'tool_injection' as const,
                  },
                }
              : {}),
          })),
        );
      }
    }

    if (exitResult) {
      runControl?.seal();
    } else {
      const interruptInputId = getSteeringInterruptInputId(stepSignal);
      if (!signal?.aborted && interruptInputId && runControl) {
        yield {
          type: 'turn_interrupted',
          inputId: interruptInputId,
          requestId: runControl.requestId,
          turn: turnsCount,
        };
      }
    }

    yield { type: 'turn_end', turn: turnsCount, hasToolCalls: true };

    if (!exitResult) {
      yield* applyPendingSteeringInputs({
        runControl,
        inputHooks,
        conversationState: convState,
        turn: turnsCount + 1,
        includeNow: true,
      });
    }

    if (exitResult) {
      const finalMessage =
        typeof exitResult.result.model === 'string' ? exitResult.result.model : '循环已退出';
      yield { type: 'agent_end' };
      return {
        success: exitResult.result.status === 'success',
        finalMessage,
        metadata: {
          turnsCount: totalTurnsCount,
          toolCallsCount: totalToolCalls,
          duration: Date.now() - startTime,
          shouldExitLoop: true,
          targetMode: exitResult.result.metadata?.targetMode as PermissionMode | undefined,
        },
      };
    }

    if (signal?.aborted) {
      yield { type: 'agent_end' };
      return buildAbortResult(totalTurnsCount, totalToolCalls, startTime);
    }

    // 轮次上限
    if (turnsCount >= effectiveMaxTurns && !isYoloMode) {
      const limitDecision = await decideTurnLimit({
        maxTurns: config.maxTurns,
        turnsCount,
        totalTurnsCount,
        contextMessages: convState.getContextMessages(),
        toolCallsCount: totalToolCalls,
        startTime,
        totalTokens,
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
      turnsCount = 0;
    }
  }
}

async function* applyPendingSteeringInputs(options: {
  runControl: AgentRunControl | undefined;
  inputHooks: AgentLoopHooks['input'];
  conversationState: ConversationState;
  turn: number;
  includeNow?: boolean;
}): AsyncGenerator<AgentEvent, boolean> {
  const inputs =
    options.runControl?.claimSteeringInputs({
      includeNow: options.includeNow,
    }) ?? [];
  return yield* applyClaimedSteeringInputs({
    ...options,
    inputs,
  });
}

async function* applyClaimedSteeringInputs(options: {
  inputs: AgentSteeringInput[];
  runControl: AgentRunControl | undefined;
  inputHooks: AgentLoopHooks['input'];
  conversationState: ConversationState;
  turn: number;
}): AsyncGenerator<AgentEvent, boolean> {
  const { inputs, runControl, inputHooks, conversationState, turn } = options;
  if (!runControl || inputs.length === 0) {
    return false;
  }

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input) {
      continue;
    }
    let durableApplicationStarted = false;
    try {
      if (inputHooks?.beforeApply) {
        await inputHooks.beforeApply({ input, turn });
        runControl.acknowledgeInput(input.inputId);
        durableApplicationStarted = true;
      }
      const message = inputHooks?.apply
        ? await inputHooks.apply({ input, turn })
        : {
            role: 'user' as const,
            content: input.content,
          };
      conversationState.append(message);
      if (!durableApplicationStarted) {
        runControl.acknowledgeInput(input.inputId);
      }
      yield {
        type: 'input_applied',
        inputId: input.inputId,
        requestId: runControl.requestId,
        priority: input.priority,
        turn,
      };
    } catch (error) {
      if (!durableApplicationStarted) {
        runControl.releaseInput(input.inputId);
      }
      for (const pending of inputs.slice(index + 1)) {
        runControl.releaseInput(pending.inputId);
      }
      throw error;
    }
  }
  return true;
}

// ===== 辅助函数 =====

function buildAbortResult(
  turnsCount: number,
  toolCallsCount: number,
  startTime: number,
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
