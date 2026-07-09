/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责循环骨架：调用 runTurn → 写消息 → 执行工具（非流式）→ 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 */

import { type InternalLogger, NOOP_LOGGER } from '../logging/Logger.js';
import type { Message, ToolCall } from '../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../tools/types/index.js';
import type { JsonObject } from '../types/common.js';
import type { AgentEvent } from './AgentEvent.js';
import {
  ExecutionEpoch,
} from './ExecutionEpoch.js';
import {
  handleAgentLoopWithEmissions,
} from './loop/agentLoop.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { runTurn } from './loop/runTurn.js';
import type { ToolExecutionUpdate } from './loop/runToolCall.js';
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

  const logger = config.logger ?? NOOP_LOGGER;

  return (yield* handleAgentLoopWithEmissions({
    signal,
    maxTurns,
    isYoloMode,
    conversation: convState,
    prepareTurnState: config.prepareTurnState,
    executionPipeline,
    streaming,
    createEpoch: () => new ExecutionEpoch(),
    logger,
    hooks,
    tokenBudget,
    runTurn,
    executeToolCalls,
  })) as LoopResult;
}
