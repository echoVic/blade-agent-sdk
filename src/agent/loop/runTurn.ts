import {
  runPackageLocalTurn,
} from '@blade-ai/agent-sdk/session/internal';
import type { InternalLogger } from '../../logging/Logger.js';
import type {
  ChatResponse,
  Message,
} from '@blade-ai/ai/chat';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { PermissionMode } from '../../types/common.js';
import type { JsonObject } from '../../types/common.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ExecutionEpoch } from '../ExecutionEpoch.js';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type { TurnState } from '../state/TurnState.js';
import type { ToolExecutionContext, ToolExecutionUpdate } from './runToolCall.js';

type RunPackageLocalTurnInput = Parameters<typeof runPackageLocalTurn>[0];
type RunPackageLocalTurnStream = ReturnType<typeof runPackageLocalTurn>;
type RunPackageLocalTurnEvent =
  RunPackageLocalTurnStream extends AsyncGenerator<infer Event, unknown, unknown>
    ? Event
    : never;
type RunPackageLocalTurnOutcome =
  RunPackageLocalTurnStream extends AsyncGenerator<unknown, infer Outcome, unknown>
    ? Outcome
    : never;
type RunPackageLocalTurnToolHooks = RunPackageLocalTurnInput['toolHooks'];

export interface RunTurnToolHooks {
  onBeforeExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
  onAfterExec?: (ctx: {
    toolCall: FunctionToolCall;
    result: ToolResult;
    toolUseUuid: string | null;
  }) => Promise<void>;
  onAfterExecEpochDiscard?: (ctx: {
    toolCall: FunctionToolCall;
    toolUseUuid: string | null;
    reason: string;
  }) => Promise<void>;
  onUpdate?: (update: ToolExecutionUpdate) => Promise<void> | void;
}

export interface RunTurnInput {
  turnState: TurnState;
  messages: readonly Message[];
  executionPipeline: ExecutionPipeline;
  streaming?: boolean;
  signal?: AbortSignal;
  epoch: ExecutionEpoch;
  executionContext: ToolExecutionContext;
  permissionMode?: PermissionMode;
  toolHooks: RunTurnToolHooks;
  logger?: InternalLogger;
}

export interface StreamingExecutionResult {
  toolCall: FunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}

export interface TurnOutcome {
  chatResponse: ChatResponse;
  streamingExecutionResults?: StreamingExecutionResult[];
}

export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const stream = runPackageLocalTurn({
    ...input,
    toolHooks: input.toolHooks as RunPackageLocalTurnToolHooks,
  } as unknown as RunPackageLocalTurnInput);

  while (true) {
    const next = await stream.next();
    if (next.done) {
      const outcome = next.value as RunPackageLocalTurnOutcome;
      return {
        chatResponse: outcome.chatResponse,
        streamingExecutionResults: outcome.streamingExecutionResults as
          | StreamingExecutionResult[]
          | undefined,
      };
    }
    yield next.value as Exclude<RunPackageLocalTurnEvent, null> as AgentEvent;
  }
}
