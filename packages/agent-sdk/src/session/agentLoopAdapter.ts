import {
  createPackageLocalAgentLoopPorts,
} from './runtimeAgentLoopPorts.js';
import { NOOP_LOGGER } from '../local/Logger.js';
import type { AgentEvent } from '../local/agentEvent.js';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { LoopResult } from '../local/agentLoopTypes.js';
import { handleAgentLoopWithEmissions } from '@blade-ai/agent/loop';
import type { AgentLoopConfig } from '../local/adapterContracts.js';

const { runTurn, executeToolCalls } = createPackageLocalAgentLoopPorts();

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
    executionPipeline: executionPipeline as never,
    streaming,
    createEpoch: () => new ExecutionEpoch(),
    logger,
    hooks,
    tokenBudget,
    runTurn: runTurn as never,
    executeToolCalls: executeToolCalls as never,
  })) as LoopResult;
}
