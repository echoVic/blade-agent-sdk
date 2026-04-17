/**
 * runTurn — 单回合 LLM 调用 + 流式事件桥接
 *
 * 职责：
 * - 根据配置选择流式/非流式分支
 * - 将 StreamingToolExecutor / streamChatResponse / ChatService 的事件
 *   统一转换成 AgentEvent 流
 * - 返回 chatResponse + 可选的 executionResults（仅流式 + 有工具时）
 *
 * agentLoop 主循环消费这个 generator，只负责循环调度。
 */

import type { JSONSchema7 } from 'json-schema';
import type { InternalLogger } from '../../logging/Logger.js';
import type {
  ChatResponse,
  Message,
} from '../../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { PermissionMode } from '../../types/common.js';
import type { JsonObject } from '../../types/common.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ExecutionEpoch } from '../ExecutionEpoch.js';
import { StreamingToolExecutor } from '../StreamingToolExecutor.js';
import type { TurnState } from '../state/TurnState.js';
import { AsyncEventQueue } from './AsyncEventQueue.js';
import type { ToolExecutionContext, ToolExecutionUpdate } from './runToolCall.js';
import { streamChatResponse } from './streamChatResponse.js';
import { toolUpdateToAgentEvent } from './toolUpdateToAgentEvent.js';
import type { FunctionToolCall } from './types.js';

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
  /** 若走了 streaming+tools 分支，工具已顺带执行完；非流式路径为 undefined */
  streamingExecutionResults?: StreamingExecutionResult[];
}

/**
 * 单回合执行。所有副作用通过 hooks 注入，事件通过 yield 输出。
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const { turnState, messages, executionPipeline, streaming, signal, epoch, logger } = input;
  const tools = turnState.tools as Array<{
    name: string;
    description: string;
    parameters: JSONSchema7;
  }>;
  const turnChatService = turnState.chatService;

  // 分支 1：streaming + 有工具 — 流式边解析边执行
  if (streaming && tools.length > 0) {
    return yield* runStreamingWithTools(input, tools);
  }

  // 分支 2：streaming only — 纯流式，无工具执行
  if (streaming) {
    const stream = streamChatResponse(
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

  // 分支 3：非流式 + 带重试事件
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

  // 分支 4：纯非流式
  const chatResponse = await turnChatService.chat(messages, tools, signal);
  return { chatResponse };
}

async function* runStreamingWithTools(
  input: RunTurnInput,
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const {
    turnState, messages, executionPipeline,
    signal, epoch, executionContext, permissionMode, toolHooks, logger,
  } = input;

  const streamingExecutor = new StreamingToolExecutor(
    () => turnState.chatService,
    logger,
  );

  const queue = new AsyncEventQueue<AgentEvent>({
    isLive: () => epoch.isValid,
  });
  const registry = executionPipeline.getRegistry();

  let chatResponse: ChatResponse | undefined;
  let streamingExecutionResults: StreamingExecutionResult[] | undefined;
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
        const agentEvent = toolUpdateToAgentEvent(update, registry);
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
