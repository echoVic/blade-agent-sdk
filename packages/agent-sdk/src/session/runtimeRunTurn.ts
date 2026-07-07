import type {
  ChatResponse,
  IChatService,
  Message,
} from '@blade-ai/ai/chat';
import {
  AsyncEventQueue,
  type AgentLoopToolEvent,
  type AgentLoopToolExecutionUpdate,
  type ExecutionEpoch,
  toolUpdateToAgentEvent,
} from '@blade-ai/agent';
import type { JsonObject, PermissionMode } from '../types/common.js';
import type {
  FunctionToolCall,
  ToolExecutionOutcome,
  ToolExecutionUpdate,
  ToolResult,
} from '../tools/types/index.js';
import type {
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

export interface PackageLocalRunTurnState {
  chatService: IChatService;
  tools: PackageLocalChatToolDefinition[];
}

export interface PackageLocalRunTurnInput {
  turnState: PackageLocalRunTurnState;
  messages: readonly Message[];
  executionPipeline: PackageLocalToolExecutionPipelinePort;
  streaming?: boolean;
  signal?: AbortSignal;
  epoch: ExecutionEpoch;
  executionContext: PackageLocalToolExecutionContext;
  permissionMode?: PermissionMode;
  toolHooks: PackageLocalRunTurnToolHooks;
  logger?: PackageLocalRunTurnLogger;
}

export interface PackageLocalStreamingExecutionResult {
  toolCall: FunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}

export interface PackageLocalTurnOutcome {
  chatResponse: ChatResponse;
  streamingExecutionResults?: PackageLocalStreamingExecutionResult[];
}

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
  | AgentLoopToolEvent;

export async function* runPackageLocalTurn(
  input: PackageLocalRunTurnInput,
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

async function* runPackageLocalStreamingTurnWithTools(
  input: PackageLocalRunTurnInput,
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

  const streamingExecutor = new PackageLocalStreamingToolExecutor(
    () => turnState.chatService,
    logger,
  );

  const queue = new AsyncEventQueue<PackageLocalRunTurnEvent>({
    isLive: () => epoch.isValid,
  });
  const registry = executionPipeline.getRegistry();

  let chatResponse: ChatResponse | undefined;
  let streamingExecutionResults: ToolExecutionOutcome[] | undefined;
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
        const agentEvent = toolUpdateToAgentEvent(
          update as AgentLoopToolExecutionUpdate,
          registry,
        );
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
