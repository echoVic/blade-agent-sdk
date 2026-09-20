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
import { getSteeringInterruptInputId } from '../types/abort.js';
import type { PermissionMode } from '../types/constants.js';
import type { MessageId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentEvent } from './AgentEvent.js';
import type { AgentRunControl, AgentSteeringInput } from './AgentRunControl.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import {
  type InitialInputPreparation,
  RECONCILED_INITIAL_INPUT,
} from './InitialInputPreparation.js';
import { isOverflowRecoverable } from './isOverflowRecoverable.js';
import { decideTurnLimit } from './loop/decideTurnLimit.js';
import { streamToolCalls, type ToolExecutionOutcome } from './loop/executeToolCalls.js';
import { planToolExecution } from './loop/planToolExecution.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
import { runTurn, type TurnOutcome } from './loop/runTurn.js';
import { toolUpdateToAgentEvent } from './loop/toolUpdateToAgentEvent.js';
import type { ModelExecutionLifecycle } from './ModelExecutionLifecycle.js';
import type { ConversationState } from './state/ConversationState.js';
import type { TurnState } from './state/TurnState.js';
import type { TokenBudget } from './TokenBudget.js';
import type { LoopResult, TurnLimitResponse } from './types.js';

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
    afterExec?: (ctx: ToolExecutionOutcome) => Promise<void>;
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

type RecoveryState =
  | { phase: 'idle' }
  | { phase: 'retry_pending' | 'in_retried_turn'; turn: number; attempt: number };

type TurnStart =
  | { action: 'abort'; result: LoopResult }
  | { action: 'run'; turnState: TurnState; stepSignal?: AbortSignal };

type ModelStep = { action: 'retry' } | { action: 'complete'; outcome: TurnOutcome };

type NoToolStep = { action: 'continue' } | { action: 'complete'; result: LoopResult };

class AgentLoopExecution {
  private readonly startedAt = Date.now();
  private turns = 0;
  private totalTurns = 0;
  private totalTools = 0;
  private totalTokens = 0;
  private lastPromptTokens?: number;
  private recovery: RecoveryState = { phase: 'idle' };

  constructor(private readonly config: AgentLoopConfig) {}

  async *run(): AsyncGenerator<AgentEvent, LoopResult> {
    yield { type: 'agent_start' };
    while (true) {
      const started = yield* this.startTurn();
      if (started.action === 'abort') return started.result;

      const model = yield* this.runModel(started.turnState, started.stepSignal);
      if (model.action === 'retry') continue;

      this.resetRecovery();
      const budgetResult = yield* this.recordUsage(
        model.outcome.chatResponse,
        started.turnState.maxContextTokens,
      );
      if (budgetResult) return budgetResult;
      if (this.config.signal?.aborted) return this.abort(this.totalTurns - 1);

      yield* this.emitModelContent(model.outcome.chatResponse, started.stepSignal);
      if (!model.outcome.chatResponse.toolCalls?.length) {
        const noTools = yield* this.finishNoToolTurn(model.outcome, started.stepSignal);
        if (noTools.action === 'complete') return noTools.result;
        continue;
      }

      const outcomes = yield* this.runTools(model.outcome, started.turnState);
      if (!outcomes) return this.abort(this.totalTurns);
      const exit = await this.commitToolRound(model.outcome, outcomes);
      const terminal = yield* this.finishToolTurn(exit, started.stepSignal);
      if (terminal) return terminal;
    }
  }

  private async *startTurn(): AsyncGenerator<AgentEvent, TurnStart> {
    const { signal, runControl, hooks } = this.config;
    runControl?.advanceStep();
    if (signal?.aborted) return { action: 'abort', result: this.abort(this.totalTurns) };

    yield* applyPendingInputs(
      runControl,
      hooks?.input,
      this.config.conversationState,
      this.turns + 1,
    );
    const skipPreparation =
      this.recovery.phase === 'retry_pending' ||
      (this.config.initialInputPreparation === RECONCILED_INITIAL_INPUT && this.totalTurns === 0);
    if (!skipPreparation && hooks?.turn?.beforeTurn) {
      yield* hooks.turn.beforeTurn({
        turn: this.turns,
        messages: this.config.conversationState.toArray(),
        lastPromptTokens: this.lastPromptTokens,
      });
    }

    if (this.recovery.phase === 'retry_pending') {
      this.recovery = { ...this.recovery, phase: 'in_retried_turn' };
    } else {
      this.turns += 1;
      this.totalTurns += 1;
      yield { type: 'turn_start', turn: this.turns, maxTurns: this.effectiveMaxTurns };
    }
    if (signal?.aborted) return { action: 'abort', result: this.abort(this.totalTurns - 1) };
    return {
      action: 'run',
      turnState: this.config.prepareTurnState(this.turns),
      stepSignal: runControl?.stepSignal ?? signal,
    };
  }

  private async *runModel(
    turnState: TurnState,
    stepSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, ModelStep> {
    try {
      const outcome = yield* runTurn({
        turnState,
        messages: this.config.conversationState.toArray(),
        streaming: this.config.streaming,
        signal: stepSignal,
        modelExecutionLifecycle: this.config.modelExecutionLifecycle,
        logger: this.config.logger,
      });
      return { action: 'complete', outcome };
    } catch (error) {
      const interrupt = getSteeringInterruptInputId(stepSignal);
      if (!this.config.signal?.aborted && interrupt && this.config.runControl) {
        yield this.interrupted(interrupt);
        yield* applyPendingInputs(
          this.config.runControl,
          this.config.hooks?.input,
          this.config.conversationState,
          this.turns + 1,
        );
        yield { type: 'turn_end', turn: this.turns, hasToolCalls: false };
        return { action: 'retry' };
      }
      if (error instanceof FallbackTriggeredError) {
        yield {
          type: 'model_fallback',
          originalModel: error.originalModel,
          fallbackModel: error.fallbackModel,
        };
        throw error;
      }
      if (yield* this.recoverOverflow(error)) return { action: 'retry' };
      throw error;
    }
  }

  private async *recoverOverflow(error: unknown): AsyncGenerator<AgentEvent, boolean> {
    const hooks = this.config.hooks?.recovery;
    if (isOverflowRecoverable(error) && hooks?.reactiveCompact && this.recovery.phase === 'idle') {
      this.recovery = { phase: 'retry_pending', turn: this.turns, attempt: 1 };
      yield { type: 'recovery', phase: 'started', reason: 'context_overflow' };
      const recovered = yield* hooks.reactiveCompact({
        messages: this.config.conversationState.toArray(),
      });
      if (!recovered) {
        yield { type: 'recovery', phase: 'failed', reason: 'reactive_compact' };
        return false;
      }
      yield { type: 'recovery', phase: 'retrying', reason: 'reactive_compact' };
      yield { type: 'turn_retry', turn: this.turns, reason: 'reactive_compact' };
      return true;
    }
    if (isOverflowRecoverable(error) && this.recovery.phase === 'in_retried_turn') {
      yield { type: 'recovery', phase: 'failed', reason: 'recovery_exhausted' };
    }
    return false;
  }

  private resetRecovery(): void {
    if (this.recovery.phase === 'idle') return;
    this.recovery = { phase: 'idle' };
  }

  private async *recordUsage(
    response: ModelResponse,
    maxContextTokens: number,
  ): AsyncGenerator<AgentEvent, LoopResult | null> {
    if (!response.usage) return null;
    this.totalTokens += response.usage.totalTokens ?? 0;
    this.lastPromptTokens = response.usage.promptTokens;
    const usage: TokenUsage = normalizeModelUsage(
      response.usage,
      maxContextTokens,
      this.totalTokens,
    );
    yield { type: 'token_usage', usage };

    const budget = this.config.tokenBudget;
    if (!budget) return null;
    budget.record(response.usage);
    if (budget.isWarning()) {
      yield { type: 'budget_warning', snapshot: budget.getSnapshot() };
    }
    if (!budget.isDiminishingReturns() && !budget.isExhausted()) return null;
    yield { type: 'agent_end' };
    return this.failure(
      'budget_exhausted',
      budget.isDiminishingReturns()
        ? 'Stopped due to diminishing returns: consecutive turns produced very few tokens'
        : 'Token budget exhausted',
    );
  }

  private async *emitModelContent(
    response: ModelResponse,
    stepSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const interrupted = getSteeringInterruptInputId(stepSignal);
    if (this.config.signal?.aborted || interrupted) return;
    if (response.reasoningContent) yield { type: 'thinking', content: response.reasoningContent };
    if (this.config.streaming || response.content?.trim()) yield { type: 'stream_end' };
  }

  private async *finishNoToolTurn(
    outcome: TurnOutcome,
    stepSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, NoToolStep> {
    const response = outcome.chatResponse;
    const content = response.content || '';
    const initialInterrupt = getSteeringInterruptInputId(stepSignal);
    if (!initialInterrupt) {
      this.config.conversationState.append({
        role: 'assistant',
        content,
        reasoningContent: response.reasoningContent,
        modelIdentity: outcome.modelIdentity,
      });
      await this.config.hooks?.message?.onAssistant?.({
        content,
        reasoningContent: response.reasoningContent,
        modelIdentity: outcome.modelIdentity,
        turn: this.turns,
      });
    }
    if (!this.config.signal?.aborted && initialInterrupt) yield this.interrupted(initialInterrupt);
    if (yield* this.applyClaimedInputs(false)) return { action: 'continue' };

    const completionInterrupt = getSteeringInterruptInputId(stepSignal);
    if (!initialInterrupt && !this.config.signal?.aborted && completionInterrupt) {
      yield this.interrupted(completionInterrupt);
    }
    if (yield* this.applyClaimedInputs(true)) return { action: 'continue' };
    await this.config.hooks?.message?.onComplete?.({ content, turn: this.turns });
    yield { type: 'turn_end', turn: this.turns, hasToolCalls: false };
    yield { type: 'agent_end' };
    return { action: 'complete', result: this.success(response.content) };
  }

  private async *applyClaimedInputs(sealIfEmpty: boolean): AsyncGenerator<AgentEvent, boolean> {
    const inputs =
      this.config.runControl?.claimSteeringInputs({
        includeNow: true,
        sealIfEmpty,
      }) ?? [];
    if (inputs.length === 0) return false;
    yield { type: 'turn_end', turn: this.turns, hasToolCalls: false };
    return yield* applyInputs(
      inputs,
      this.config.runControl,
      this.config.hooks?.input,
      this.config.conversationState,
      this.turns + 1,
    );
  }

  private async *runTools(
    outcome: TurnOutcome,
    turnState: TurnState,
  ): AsyncGenerator<AgentEvent, ToolExecutionOutcome[] | null> {
    const calls = (outcome.chatResponse.toolCalls ?? []).filter(
      (call): call is ModelToolCall => call.type === 'function',
    );
    const plan = planToolExecution(calls, turnState.permissionMode);
    if (this.config.signal?.aborted) return null;
    const stream = streamToolCalls({
      plan,
      executionPipeline: this.config.executionPipeline,
      executionContext: outcome.modelAttemptId
        ? { ...turnState.executionContext, modelAttemptId: outcome.modelAttemptId }
        : turnState.executionContext,
      logger: this.config.logger,
      permissionMode: turnState.permissionMode,
      signal: this.config.signal,
      steeringSignal: this.config.runControl?.steeringSignal,
      hooks: {
        onBeforeToolExec: this.config.hooks?.tool?.beforeExec,
        onUpdate: this.config.hooks?.tool?.onUpdate,
      },
    });
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
      const event = toolUpdateToAgentEvent(next.value, this.config.executionPipeline.getRegistry());
      if (event) yield event;
    }
  }

  private async commitToolRound(
    outcome: TurnOutcome,
    executions: ToolExecutionOutcome[],
  ): Promise<ToolExecutionOutcome | undefined> {
    const response = outcome.chatResponse;
    this.config.conversationState.append({
      role: 'assistant',
      content: response.content || '',
      reasoningContent: response.reasoningContent,
      tool_calls: response.toolCalls,
      modelIdentity: outcome.modelIdentity,
    });
    await this.config.hooks?.message?.onAssistant?.({
      content: response.content || '',
      reasoningContent: response.reasoningContent,
      toolCalls: response.toolCalls,
      modelIdentity: outcome.modelIdentity,
      turn: this.turns,
    });

    let exit: ToolExecutionOutcome | undefined;
    for (const execution of executions) {
      this.totalTools += 1;
      if (execution.result.metadata?.shouldExitLoop && !exit) exit = execution;
      await this.config.hooks?.tool?.afterExec?.(execution);
      this.appendToolResult(execution);
    }
    this.appendInjectedMessages(executions.flatMap((execution) => execution.effects));
    return exit;
  }

  private appendToolResult({ toolCall, result }: ToolExecutionOutcome): void {
    const content =
      typeof result.model === 'string' ? result.model : JSON.stringify(result.model, null, 2);
    this.config.conversationState.append({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content,
      ...(result.status === 'error' ? { extensions: { toolErrorType: result.error.type } } : {}),
    });
  }

  private appendInjectedMessages(effects: readonly ToolEffect[]): void {
    const messages = effects.flatMap((effect) =>
      effect.type === 'newMessages' ? effect.messages : [],
    );
    this.config.conversationState.append(
      ...messages.map((message) => ({
        ...message,
        ...(message.role === 'system' ? { provenance: { source: 'tool_injection' as const } } : {}),
      })),
    );
  }

  private async *finishToolTurn(
    exit: ToolExecutionOutcome | undefined,
    stepSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, LoopResult | null> {
    if (exit) {
      this.config.runControl?.seal();
    } else {
      const interrupt = getSteeringInterruptInputId(stepSignal);
      if (!this.config.signal?.aborted && interrupt) yield this.interrupted(interrupt);
    }
    yield { type: 'turn_end', turn: this.turns, hasToolCalls: true };
    if (!exit) {
      yield* applyPendingInputs(
        this.config.runControl,
        this.config.hooks?.input,
        this.config.conversationState,
        this.turns + 1,
      );
    }
    if (exit) {
      yield { type: 'agent_end' };
      const final = typeof exit.result.model === 'string' ? exit.result.model : '循环已退出';
      return this.success(final, {
        shouldExitLoop: true,
        targetMode: exit.result.metadata?.targetMode as PermissionMode | undefined,
      });
    }
    if (this.config.signal?.aborted) return this.abort(this.totalTurns);
    return yield* this.enforceTurnLimit();
  }

  private async *enforceTurnLimit(): AsyncGenerator<AgentEvent, LoopResult | null> {
    if (this.turns < this.effectiveMaxTurns || this.config.isYoloMode) return null;
    const decision = await decideTurnLimit({
      maxTurns: this.config.maxTurns,
      turnsCount: this.turns,
      totalTurnsCount: this.totalTurns,
      contextMessages: this.config.conversationState.getContextMessages(),
      toolCallsCount: this.totalTools,
      startTime: this.startedAt,
      totalTokens: this.totalTokens,
      onTurnLimitReached: this.config.hooks?.turn?.onTurnLimitReached,
      onTurnLimitCompact: this.config.hooks?.turn?.onTurnLimitCompact,
    });
    if (decision.action === 'stop') {
      yield { type: 'agent_end' };
      return decision.result;
    }
    if (decision.compactedMessages) {
      this.config.conversationState.replaceContent(decision.compactedMessages);
      if (decision.continueMessage) {
        this.config.conversationState.append(decision.continueMessage);
      }
    }
    this.turns = 0;
    return null;
  }

  private interrupted(inputId: ReturnType<typeof getSteeringInterruptInputId>): AgentEvent {
    if (!inputId || !this.config.runControl) {
      throw new Error('Cannot emit a turn interruption without run control');
    }
    return {
      type: 'turn_interrupted',
      inputId,
      requestId: this.config.runControl.requestId,
      turn: this.turns,
    };
  }

  private success(
    finalMessage?: string,
    metadata: Partial<NonNullable<LoopResult['metadata']>> = {},
  ): LoopResult {
    return {
      success: true,
      finalMessage,
      metadata: { ...this.metadata(), ...metadata },
    };
  }

  private failure(type: 'budget_exhausted', message: string): LoopResult {
    return {
      success: false,
      error: { type, message },
      metadata: this.metadata(),
    };
  }

  private abort(turnsCount: number): LoopResult {
    return {
      success: false,
      error: { type: 'aborted', message: '任务已被用户中止' },
      metadata: { ...this.metadata(), turnsCount },
    };
  }

  private metadata(): NonNullable<LoopResult['metadata']> {
    return {
      turnsCount: this.totalTurns,
      toolCallsCount: this.totalTools,
      duration: Date.now() - this.startedAt,
      tokensUsed: this.totalTokens,
      tokenBudgetSnapshot: this.config.tokenBudget?.getSnapshot(),
    };
  }

  private get effectiveMaxTurns(): number {
    return this.config.isYoloMode ? AGENT_TURN_SAFETY_LIMIT : this.config.maxTurns;
  }
}

export function agentLoop(config: AgentLoopConfig): AsyncGenerator<AgentEvent, LoopResult> {
  return new AgentLoopExecution(config).run();
}

async function* applyPendingInputs(
  runControl: AgentRunControl | undefined,
  hooks: AgentLoopHooks['input'],
  conversation: ConversationState,
  turn: number,
): AsyncGenerator<AgentEvent, boolean> {
  return yield* applyInputs(
    runControl?.claimSteeringInputs({ includeNow: true }) ?? [],
    runControl,
    hooks,
    conversation,
    turn,
  );
}

async function* applyInputs(
  inputs: AgentSteeringInput[],
  runControl: AgentRunControl | undefined,
  hooks: AgentLoopHooks['input'],
  conversation: ConversationState,
  turn: number,
): AsyncGenerator<AgentEvent, boolean> {
  if (!runControl || inputs.length === 0) return false;
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    let durable = false;
    try {
      if (hooks?.beforeApply) {
        await hooks.beforeApply({ input, turn });
        runControl.acknowledgeInput(input.inputId);
        durable = true;
      }
      const message = hooks?.apply
        ? await hooks.apply({ input, turn })
        : { role: 'user' as const, content: input.content };
      conversation.append(message);
      if (!durable) runControl.acknowledgeInput(input.inputId);
      yield {
        type: 'input_applied',
        inputId: input.inputId,
        requestId: runControl.requestId,
        priority: input.priority,
        turn,
      };
    } catch (error) {
      if (!durable) runControl.releaseInput(input.inputId);
      for (const pending of inputs.slice(index + 1)) runControl.releaseInput(pending.inputId);
      throw error;
    }
  }
  return true;
}
