/**
 * AgentLoop — 纯 Agent 循环
 *
 * 1. 只负责循环骨架：调用 runTurn → 写消息 → 执行工具（非流式）→ 继续或退出
 * 2. 所有副作用（JSONL 保存、调试日志、模型切换）通过 hooks 注入
 * 3. 使用 AsyncGenerator<AgentEvent, LoopResult> 统一输出
 */

import { NOOP_LOGGER } from '../logging/Logger.js';
import type { AgentEvent } from './AgentEvent.js';
import {
  ExecutionEpoch,
} from './ExecutionEpoch.js';
import { handleAgentLoopWithEmissions } from './loop/agentLoop.js';
import type { AgentLoopConfig } from './loop/adapterContracts.js';
import { executeToolCalls } from './loop/executeToolCalls.js';
import { runTurn } from './loop/runTurn.js';
import type { LoopResult } from './types.js';

// ===== Loop 配置 =====

export type { AgentLoopConfig, AgentLoopHooks } from './loop/adapterContracts.js';

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
