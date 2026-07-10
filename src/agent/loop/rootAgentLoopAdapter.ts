import {
  runPackageLocalToolCall,
} from '@blade-ai/agent-sdk/session/internal';
import { LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { AgentEvent } from '../AgentEvent.js';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { LoopResult } from '../types.js';
import { handleAgentLoopWithEmissions } from './agentLoop.js';
import type { AgentLoopConfig, RunToolCallPort } from './adapterContracts.js';
import { createExecuteToolCalls } from './executeToolCalls.js';
import { runTurn } from './runTurn.js';

type PackageLocalRunToolCall = typeof runPackageLocalToolCall;
type PackageLocalRunToolCallInput = Parameters<PackageLocalRunToolCall>[0];
type PackageLocalExecutionPipeline = PackageLocalRunToolCallInput['executionPipeline'];

function createPackageLocalExecutionPipeline(
  input: Parameters<RunToolCallPort>[0],
): PackageLocalExecutionPipeline {
  const rootExecutionPipeline = input.executionPipeline;
  const rootExecutionContext = input.executionContext;

  return {
    execute: (toolName, params, context) => rootExecutionPipeline.execute(
      toolName,
      params,
      {
        ...rootExecutionContext,
        signal: context.signal,
        onProgress: context.onProgress,
        updateOutput: context.updateOutput,
        permissionMode: context.permissionMode,
      },
    ),
    getRegistry: () => rootExecutionPipeline.getRegistry(),
  };
}

export function createRootRunToolCall(
  packageLocalRunToolCall: PackageLocalRunToolCall = runPackageLocalToolCall,
): RunToolCallPort {
  return (input) => packageLocalRunToolCall({
    ...input,
    executionPipeline: createPackageLocalExecutionPipeline(input),
    logger: input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT),
  });
}

const runToolCall = createRootRunToolCall(runPackageLocalToolCall);

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
