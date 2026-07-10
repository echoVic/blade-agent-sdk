import type {
  ChatResponse,
  IChatService,
  Message,
} from '@blade-ai/ai/chat';
import {
  AsyncEventQueue,
  type AgentLoopToolEvent,
  type AgentFunctionToolCall,
  type AgentToolExecutionUpdatePayloads,
  toolUpdateToAgentEvent,
} from '@blade-ai/agent/loop';
import type { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { JsonObject, PermissionMode } from '../types/common.js';
import type {
  ToolEffect,
  ToolResult,
} from '../tools/types/index.js';
import type {
  PackageLocalToolExecutionOutcome,
  PackageLocalToolExecutionUpdate,
  PackageLocalToolExecutionContext,
  PackageLocalToolExecutionPipelinePort,
} from './runtimeToolExecution.js';
import {
  streamPackageLocalChatResponse,
  type PackageLocalChatToolDefinition,
} from './streamChatResponse.js';
import { PackageLocalStreamingToolExecutor } from './streamingToolExecutor.js';

export interface PackageLocalRunTurnLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface PackageLocalRunTurnToolHooks {
  onBeforeExec?: (ctx: {
    toolCall: AgentFunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
  onAfterExec?: (ctx: {
    toolCall: AgentFunctionToolCall;
    result: ToolResult;
    toolUseUuid: string | null;
  }) => Promise<void>;
  onAfterExecEpochDiscard?: (ctx: {
    toolCall: AgentFunctionToolCall;
    toolUseUuid: string | null;
    reason: string;
  }) => Promise<void>;
  onUpdate?: (update: PackageLocalToolExecutionUpdate) => Promise<void> | void;
}

export interface PackageLocalRunTurnState {
  chatService: IChatService;
  tools: PackageLocalChatToolDefinition[];
}

export interface PackageLocalRunTurnInput<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
> {
  turnState: PackageLocalRunTurnState;
  messages: readonly Message[];
  executionPipeline: PackageLocalToolExecutionPipelinePort<TExecutionContext>;
  streaming?: boolean;
  signal?: AbortSignal;
  epoch: ExecutionEpoch;
  executionContext: TExecutionContext;
  permissionMode?: PermissionMode;
  toolHooks: PackageLocalRunTurnToolHooks;
  logger?: PackageLocalRunTurnLogger;
}

export interface PackageLocalStreamingExecutionResult {
  toolCall: AgentFunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}

export interface PackageLocalTurnOutcome {
  chatResponse: ChatResponse;
  streamingExecutionResults?: PackageLocalStreamingExecutionResult[];
}

interface PackageLocalRunTurnToolEventPayloads extends AgentToolExecutionUpdatePayloads {
  params: JsonObject;
  runtimePatch: Extract<ToolEffect, { type: 'runtimePatch' }>['patch'];
  contextPatch: Extract<ToolEffect, { type: 'contextPatch' }>['patch'];
  newMessages: Extract<ToolEffect, { type: 'newMessages' }>['messages'];
  permissionUpdates: Extract<ToolEffect, { type: 'permissionUpdates' }>['updates'];
}

type PackageLocalRunTurnToolEvent = AgentLoopToolEvent<
  AgentFunctionToolCall,
  ToolResult,
  PackageLocalRunTurnToolEventPayloads
>;

export type PackageLocalRunTurnEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'stream_end' }
  | {
      type: 'api_retry';
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: {
        status?: number;
        message: string;
      };
    }
  | PackageLocalRunTurnToolEvent;

export async function* runPackageLocalTurn<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
>(
  input: PackageLocalRunTurnInput<TExecutionContext>,
): AsyncGenerator<PackageLocalRunTurnEvent, PackageLocalTurnOutcome> {
  const { turnState, messages, streaming, signal, logger } = input;
  const tools = turnState.tools;
  const turnChatService = turnState.chatService;

  if (streaming && tools.length > 0) {
    return yield* runPackageLocalStreamingTurnWithTools(input, tools);
  }

  if (streaming) {
    const stream = streamPackageLocalChatResponse(
      () => turnChatService,
      messages,
      tools,
      signal,
      logger,
    );
    let chatResponse: ChatResponse | undefined;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        chatResponse = value;
        break;
      }
      if (value.type === 'content_delta') {
        yield { type: 'content_delta', delta: value.delta };
      } else {
        yield { type: 'thinking_delta', delta: value.delta };
      }
    }
    if (!chatResponse) {
      throw new Error('Stream terminated without chat response');
    }
    return { chatResponse };
  }

  if (typeof turnChatService.chatWithRetryEvents === 'function') {
    const retryGen = turnChatService.chatWithRetryEvents(messages, tools, signal);
    while (true) {
      const { value, done } = await retryGen.next();
      if (done) {
        return { chatResponse: value };
      }
      yield {
        type: 'api_retry',
        attempt: value.attempt,
        maxRetries: value.maxRetries,
        delayMs: value.delayMs,
        error: value.error,
      };
    }
  }

  const chatResponse = await turnChatService.chat(messages, tools, signal);
  return { chatResponse };
}

async function* runPackageLocalStreamingTurnWithTools<
  TExecutionContext extends PackageLocalToolExecutionContext,
>(
  input: PackageLocalRunTurnInput<TExecutionContext>,
  tools: PackageLocalChatToolDefinition[],
): AsyncGenerator<PackageLocalRunTurnEvent, PackageLocalTurnOutcome> {
  const {
    turnState,
    messages,
    executionPipeline,
    signal,
    epoch,
    executionContext,
    permissionMode,
    toolHooks,
    logger,
  } = input;

  const streamingExecutor = new PackageLocalStreamingToolExecutor<TExecutionContext>(
    () => turnState.chatService,
    logger,
  );

  const queue = new AsyncEventQueue<PackageLocalRunTurnEvent>({
    isLive: () => epoch.isValid,
  });
  const registry = executionPipeline.getRegistry();

  let chatResponse: ChatResponse | undefined;
  let streamingExecutionResults: PackageLocalToolExecutionOutcome[] | undefined;
  let executionError: unknown;

  const executionPromise = streamingExecutor
    .collectAndExecute(messages, tools, signal, {
      executionPipeline,
      executionContext,
      logger,
      permissionMode,
      hooks: {
        onBeforeToolExec: toolHooks.onBeforeExec,
      },
      onAfterToolExec: toolHooks.onAfterExec,
      onAfterToolExecEpochDiscard: toolHooks.onAfterExecEpochDiscard,
      onContentDelta: (delta) => queue.enqueue({ type: 'content_delta', delta }),
      onThinkingDelta: (delta) => queue.enqueue({ type: 'thinking_delta', delta }),
      onStreamEnd: () => {
        if (!signal?.aborted) queue.enqueue({ type: 'stream_end' });
      },
      onToolExecutionUpdate: async (update) => {
        await toolHooks.onUpdate?.(update);
        const agentEvent = toolUpdateToAgentEvent<
          AgentFunctionToolCall,
          ToolResult,
          PackageLocalRunTurnToolEventPayloads,
          PackageLocalToolExecutionOutcome
        >(update, registry);
        if (agentEvent) queue.enqueue(agentEvent);
      },
    }, epoch)
    .then(({ chatResponse: resp, executionResults }) => {
      chatResponse = resp;
      streamingExecutionResults = executionResults;
    })
    .catch((error: unknown) => {
      executionError = error;
    })
    .finally(() => {
      queue.close();
    });

  for await (const event of queue) {
    yield event;
  }

  await executionPromise;

  if (executionError) {
    throw executionError;
  }

  if (!chatResponse) {
    throw new Error('Streaming executor completed without chat response');
  }

  return { chatResponse, streamingExecutionResults };
}
