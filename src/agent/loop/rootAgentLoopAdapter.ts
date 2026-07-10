import {
  runPackageLocalTurn,
  runPackageLocalToolCall,
} from '@blade-ai/agent-sdk/session/internal';
import { LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { ToolErrorType } from '../../tools/types/ToolResult.js';
import { ToolKind } from '../../tools/types/ToolKind.js';
import type { AgentEvent } from '../AgentEvent.js';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { LoopResult } from '../types.js';
import { handleAgentLoopWithEmissions } from './agentLoop.js';
import type {
  AgentLoopConfig,
  RunToolCallInput,
  RunToolCallPort,
  RunTurnInput,
  RunTurnPort,
  StreamingExecutionResult,
  ToolExecutionContext,
  ToolExecutionUpdate,
  TurnOutcome,
} from './adapterContracts.js';
import { createExecuteToolCalls } from './executeToolCalls.js';

type PackageLocalRunToolCall = typeof runPackageLocalToolCall;
type PackageLocalRunToolCallInput = Parameters<PackageLocalRunToolCall>[0];
type PackageLocalExecutionPipeline = PackageLocalRunToolCallInput['executionPipeline'];
type PackageLocalRunTurn = typeof runPackageLocalTurn;
type PackageLocalRunTurnInput = Parameters<PackageLocalRunTurn>[0];
type PackageLocalRunTurnStream = ReturnType<PackageLocalRunTurn>;
type PackageLocalRunTurnEvent =
  PackageLocalRunTurnStream extends AsyncGenerator<infer Event, unknown, unknown>
    ? Event
    : never;
type PackageLocalTurnOutcome =
  PackageLocalRunTurnStream extends AsyncGenerator<unknown, infer Outcome, unknown>
    ? Outcome
    : never;
type PackageLocalStreamingExecutionResult = NonNullable<
  PackageLocalTurnOutcome['streamingExecutionResults']
>[number];
type PackageLocalToolResult = PackageLocalStreamingExecutionResult['result'];
type PackageLocalToolErrorType = Extract<
  PackageLocalToolResult,
  { success: false }
>['error']['type'];
type PackageLocalToolExecutionUpdate = Parameters<
  NonNullable<PackageLocalRunTurnInput['toolHooks']['onUpdate']>
>[0];

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

function mapPackageLocalToolErrorType(
  type: PackageLocalToolErrorType,
): ToolErrorType {
  switch (type) {
    case 'validation_error':
      return ToolErrorType.VALIDATION_ERROR;
    case 'permission_denied':
      return ToolErrorType.PERMISSION_DENIED;
    case 'execution_error':
      return ToolErrorType.EXECUTION_ERROR;
    case 'timeout_error':
      return ToolErrorType.TIMEOUT_ERROR;
    case 'network_error':
      return ToolErrorType.NETWORK_ERROR;
    default:
      return ToolErrorType.EXECUTION_ERROR;
  }
}

function mapPackageLocalToolResult(
  result: PackageLocalToolResult,
): StreamingExecutionResult['result'] {
  if (result.success) {
    return { ...result };
  }

  return {
    ...result,
    error: {
      ...result.error,
      type: mapPackageLocalToolErrorType(result.error.type),
    },
  };
}

function mapPackageLocalStreamingExecutionResult(
  outcome: PackageLocalStreamingExecutionResult,
): StreamingExecutionResult {
  return {
    toolCall: outcome.toolCall,
    result: mapPackageLocalToolResult(outcome.result),
    toolUseUuid: outcome.toolUseUuid,
  };
}

function mapPackageLocalToolExecutionUpdate(
  update: PackageLocalToolExecutionUpdate,
): ToolExecutionUpdate {
  switch (update.type) {
    case 'tool_ready':
      return { type: update.type, toolCall: update.toolCall };
    case 'tool_started':
      return {
        type: update.type,
        toolCall: update.toolCall,
        params: update.params,
        toolUseUuid: update.toolUseUuid,
      };
    case 'tool_progress':
    case 'tool_message':
      return {
        type: update.type,
        toolCall: update.toolCall,
        message: update.message,
      };
    case 'tool_runtime_patch':
      return {
        type: update.type,
        toolCall: update.toolCall,
        patch: update.patch,
      };
    case 'tool_context_patch':
      return {
        type: update.type,
        toolCall: update.toolCall,
        patch: update.patch,
      };
    case 'tool_new_messages':
      return {
        type: update.type,
        toolCall: update.toolCall,
        messages: update.messages,
      };
    case 'tool_permission_updates':
      return {
        type: update.type,
        toolCall: update.toolCall,
        updates: update.updates,
      };
    case 'tool_result':
    case 'tool_completed':
      return {
        type: update.type,
        outcome: mapPackageLocalStreamingExecutionResult(update.outcome),
      };
  }
}

function createPackageLocalRunTurnToolHooks(
  hooks: RunTurnInput['toolHooks'],
): PackageLocalRunTurnInput['toolHooks'] {
  return {
    onBeforeExec: hooks.onBeforeExec,
    onAfterExec: hooks.onAfterExec
      ? async (outcome) => hooks.onAfterExec?.({
        ...outcome,
        result: mapPackageLocalToolResult(outcome.result),
      })
      : undefined,
    onAfterExecEpochDiscard: hooks.onAfterExecEpochDiscard,
    onUpdate: hooks.onUpdate
      ? (update) => hooks.onUpdate?.(mapPackageLocalToolExecutionUpdate(update))
      : undefined,
  };
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
  switch (event.type) {
    case 'content_delta':
    case 'thinking_delta':
    case 'stream_end':
    case 'api_retry':
      return event;
    case 'tool_start':
      return {
        type: event.type,
        toolCall: event.toolCall,
        toolKind: mapPackageLocalToolKind(event.toolKind),
      };
    case 'tool_result':
      return {
        type: event.type,
        toolCall: event.toolCall,
        result: mapPackageLocalToolResult(event.result),
      };
    case 'tool_progress':
    case 'tool_message':
      return {
        type: event.type,
        toolCall: event.toolCall,
        message: event.message,
      };
    case 'tool_runtime_patch':
      return {
        type: event.type,
        toolCall: event.toolCall,
        patch: event.patch,
      };
    case 'tool_context_patch':
      return {
        type: event.type,
        toolCall: event.toolCall,
        patch: event.patch,
      };
    case 'tool_new_messages':
      return {
        type: event.type,
        toolCall: event.toolCall,
        messages: event.messages,
      };
    case 'tool_permission_updates':
      return {
        type: event.type,
        toolCall: event.toolCall,
        updates: event.updates,
      };
  }
}

function mapPackageLocalTurnOutcome(
  outcome: PackageLocalTurnOutcome,
): TurnOutcome {
  return {
    chatResponse: outcome.chatResponse,
    streamingExecutionResults: outcome.streamingExecutionResults?.map(
      mapPackageLocalStreamingExecutionResult,
    ),
  };
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
      toolHooks: createPackageLocalRunTurnToolHooks(input.toolHooks),
      logger: input.logger,
    });

    while (true) {
      const next = await stream.next();
      if (next.done) {
        return mapPackageLocalTurnOutcome(next.value);
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
