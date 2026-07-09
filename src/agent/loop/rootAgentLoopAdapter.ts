import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { AgentEvent } from '../AgentEvent.js';
import { ExecutionEpoch } from '../ExecutionEpoch.js';
import type { LoopResult } from '../types.js';
import { handleAgentLoopWithEmissions } from './agentLoop.js';
import type { AgentLoopConfig } from './adapterContracts.js';
import { executeToolCalls } from './executeToolCalls.js';
import { runTurn } from './runTurn.js';

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
