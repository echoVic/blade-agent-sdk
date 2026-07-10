import {
  runPackageLocalTurn,
  runPackageLocalToolCall,
} from '@blade-ai/agent-sdk/session/internal';
import { LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { AgentEvent } from '../AgentEvent.js';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { LoopResult } from '../types.js';
import { handleAgentLoopWithEmissions } from './agentLoop.js';
import type {
  AgentLoopConfig,
  RunToolCallPort,
  RunTurnPort,
} from './adapterContracts.js';
import { createExecuteToolCalls } from './executeToolCalls.js';

type PackageLocalRunToolCall = typeof runPackageLocalToolCall;
type PackageLocalRunTurn = typeof runPackageLocalTurn;

export function createRootRunToolCall(
  packageLocalRunToolCall: PackageLocalRunToolCall = runPackageLocalToolCall,
): RunToolCallPort {
  return (input) => packageLocalRunToolCall({
    ...input,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    logger: input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT),
  });
}

export function createRootRunTurn(
  packageLocalRunTurn: PackageLocalRunTurn = runPackageLocalTurn,
): RunTurnPort {
  return async function* rootRunTurn(input) {
    const stream = packageLocalRunTurn({
      turnState: {
        chatService: input.turnState.chatService,
        tools: input.turnState.tools,
      },
      messages: input.messages,
      executionPipeline: input.executionPipeline,
      streaming: input.streaming,
      signal: input.signal,
      epoch: input.epoch,
      executionContext: input.executionContext,
      permissionMode: input.permissionMode,
      toolHooks: input.toolHooks,
      logger: input.logger,
    });

    while (true) {
      const next = await stream.next();
      if (next.done) {
        return next.value;
      }
      yield next.value;
    }
  };
}

const runToolCall = createRootRunToolCall(runPackageLocalToolCall);
const runTurn = createRootRunTurn(runPackageLocalTurn);

const executeToolCalls = createExecuteToolCalls(runToolCall);

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
