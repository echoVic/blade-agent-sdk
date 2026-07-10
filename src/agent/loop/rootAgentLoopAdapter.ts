import {
  runPackageLocalTurn,
  runPackageLocalToolCall,
} from '@blade-ai/agent-sdk/session/internal';
import { LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { ToolKind } from '../../tools/types/ToolKind.js';
import type { AgentEvent } from '../AgentEvent.js';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { LoopResult } from '../types.js';
import { handleAgentLoopWithEmissions } from './agentLoop.js';
import type {
  AgentLoopConfig,
  RunToolCallInput,
  RunToolCallPort,
  RunTurnPort,
  ToolExecutionContext,
} from './adapterContracts.js';
import { createExecuteToolCalls } from './executeToolCalls.js';

type PackageLocalRunToolCall = typeof runPackageLocalToolCall;
type PackageLocalRunToolCallInput = Parameters<PackageLocalRunToolCall>[0];
type PackageLocalExecutionPipeline = PackageLocalRunToolCallInput['executionPipeline'];
type PackageLocalRunTurn = typeof runPackageLocalTurn;
type PackageLocalRunTurnStream = ReturnType<PackageLocalRunTurn>;
type PackageLocalRunTurnEvent =
  PackageLocalRunTurnStream extends AsyncGenerator<infer Event, unknown, unknown>
    ? Event
    : never;

function createPackageLocalExecutionPipeline(
  rootExecutionPipeline: RunToolCallInput['executionPipeline'],
  rootExecutionContext: ToolExecutionContext,
): PackageLocalExecutionPipeline {
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
    executionPipeline: createPackageLocalExecutionPipeline(
      input.executionPipeline,
      input.executionContext,
    ),
    logger: input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT),
  });
}

function mapPackageLocalToolKind(
  toolKind: string | undefined,
): ToolKind | undefined {
  switch (toolKind) {
    case ToolKind.ReadOnly:
      return ToolKind.ReadOnly;
    case ToolKind.Write:
      return ToolKind.Write;
    case ToolKind.Execute:
      return ToolKind.Execute;
    default:
      return undefined;
  }
}

function mapPackageLocalRunTurnEvent(
  event: PackageLocalRunTurnEvent,
): AgentEvent {
  if (event.type === 'tool_start') {
    return {
      type: event.type,
      toolCall: event.toolCall,
      toolKind: mapPackageLocalToolKind(event.toolKind),
    };
  }

  return event;
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
      executionPipeline: createPackageLocalExecutionPipeline(
        input.executionPipeline,
        input.executionContext,
      ),
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
      yield mapPackageLocalRunTurnEvent(next.value);
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
