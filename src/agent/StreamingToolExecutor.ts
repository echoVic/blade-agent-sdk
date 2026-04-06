import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamToolCall,
} from '../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../tools/types/index.js';
import { ToolErrorType } from '../tools/types/index.js';
import type { PermissionMode } from '../types/common.js';
import { executeToolCalls, type ToolExecutionOutcome } from './loop/executeToolCalls.js';
import { planToolExecution } from './loop/planToolExecution.js';
import {
  emitToolExecutionUpdate,
  runToolCall,
  type ToolExecutionContext,
  type ToolExecutionUpdate,
} from './loop/runToolCall.js';
import type { FunctionToolCall } from './loop/types.js';
import type { StreamResponseHandler } from './StreamResponseHandler.js';

interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: Record<string, unknown>;
  }) => Promise<string | null>;
}

export interface StreamingToolExecutorConfig {
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  hooks?: ToolExecutionHooks;
  onContentDelta?: (delta: string) => void | Promise<void>;
  onThinkingDelta?: (delta: string) => void | Promise<void>;
  onStreamEnd?: () => void | Promise<void>;
  onToolExecutionUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
  onToolReady?: (toolCall: FunctionToolCall) => void | Promise<void>;
  onToolComplete?: (
    toolCall: FunctionToolCall,
    result: ToolResult,
  ) => void | Promise<void>;
  onAfterToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    result: ToolResult;
    toolUseUuid: string | null;
  }) => void | Promise<void>;
}

interface ToolCallAccumulatorEntry {
  id: string;
  name: string;
  arguments: string;
  dispatched: boolean;
  cancelled: boolean;
}

export class StreamingToolExecutor {
  private readonly logger: InternalLogger;

  constructor(
    private readonly streamHandler: StreamResponseHandler,
    private readonly getChatService: () => IChatService,
    logger?: InternalLogger,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  async collectAndExecute(
    messages: Message[],
    tools: Array<{ name: string; description: string; parameters: unknown }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
  ): Promise<{
    chatResponse: ChatResponse;
    executionResults: ToolExecutionOutcome[];
  }> {
    const chatService = this.getChatService();
    const batchController = new AbortController();
    const toolCallAccumulator = new Map<number, ToolCallAccumulatorEntry>();
    const executionResults: Array<ToolExecutionOutcome | undefined> = [];
    const inFlightExecutions = new Map<number, Promise<void>>();
    let fullContent = '';
    let fullReasoningContent = '';
    let streamUsage: ChatResponse['usage'];
    let chunkCount = 0;
    let hasDispatchedTools = false;

    try {
      const stream = chatService.streamChat(messages, tools, signal);

      for await (const chunk of stream) {
        chunkCount += 1;

        if (signal?.aborted) {
          break;
        }

        if (chunk.content) {
          fullContent += chunk.content;
          await executionConfig.onContentDelta?.(chunk.content);
        }

        if (chunk.reasoningContent) {
          fullReasoningContent += chunk.reasoningContent;
          await executionConfig.onThinkingDelta?.(chunk.reasoningContent);
        }

        if (chunk.usage) {
          streamUsage = chunk.usage;
        }

        if (chunk.toolCalls) {
          for (const toolCallChunk of chunk.toolCalls) {
            this.accumulateToolCall(toolCallAccumulator, toolCallChunk);
          }

          hasDispatchedTools = (await this.dispatchReadyToolCalls({
            accumulator: toolCallAccumulator,
            executionResults,
            inFlightExecutions,
            signal,
            batchController,
            executionConfig,
            forcePending: false,
          })) || hasDispatchedTools;
        }

        if (chunk.finishReason) {
          break;
        }
      }

      if (
        chunkCount === 0 &&
        !signal?.aborted &&
        fullContent.length === 0 &&
        toolCallAccumulator.size === 0
      ) {
        this.logger.warn('[Agent] 流式响应返回0个chunk，回退到包装的 StreamResponseHandler');
        return this.collectWithWrappedHandler(messages, tools, signal, executionConfig);
      }

      if (!signal?.aborted) {
        await executionConfig.onStreamEnd?.();
      }

      hasDispatchedTools = (await this.dispatchReadyToolCalls({
        accumulator: toolCallAccumulator,
        executionResults,
        inFlightExecutions,
        signal,
        batchController,
        executionConfig,
        forcePending: false,
      })) || hasDispatchedTools;

      await Promise.all(inFlightExecutions.values());

      hasDispatchedTools = (await this.dispatchReadyToolCalls({
        accumulator: toolCallAccumulator,
        executionResults,
        inFlightExecutions,
        signal,
        batchController,
        executionConfig,
        forcePending: true,
      })) || hasDispatchedTools;

      await Promise.all(inFlightExecutions.values());

      return {
        chatResponse: {
          content: fullContent,
          reasoningContent: fullReasoningContent || undefined,
          toolCalls: this.buildFinalToolCalls(toolCallAccumulator),
          usage: streamUsage,
        },
        executionResults: executionResults.filter(
          (result): result is ToolExecutionOutcome => result !== undefined,
        ),
      };
    } catch (error) {
      if (this.isStreamingNotSupportedError(error)) {
        this.logger.warn('[Agent] 流式请求失败，回退到包装的 StreamResponseHandler');
        return this.collectWithWrappedHandler(messages, tools, signal, executionConfig);
      }

      if (hasDispatchedTools) {
        await Promise.allSettled(Array.from(inFlightExecutions.values()));
        this.logger.warn('[Agent] 流式响应在工具派发后失败，已等待在途工具完成并继续抛出原始错误');
      }

      throw error;
    }
  }

  private async emitToolExecutionUpdate(
    executionConfig: StreamingToolExecutorConfig,
    update: ToolExecutionUpdate,
  ): Promise<void> {
    await executionConfig.onToolExecutionUpdate?.(update);
    await emitToolExecutionUpdate(
      {
        onToolReady: executionConfig.onToolReady,
        onAfterToolExec: executionConfig.onAfterToolExec,
        onToolComplete: executionConfig.onToolComplete,
      },
      update,
    );
  }

  private async collectWithWrappedHandler(
    messages: Message[],
    tools: Array<{ name: string; description: string; parameters: unknown }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
  ): Promise<{
    chatResponse: ChatResponse;
    executionResults: ToolExecutionOutcome[];
  }> {
    const stream = this.streamHandler.streamResponse(messages, tools, signal);
    let chatResponse: ChatResponse | undefined;

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        chatResponse = value;
        break;
      }

      if (value.type === 'content_delta') {
        await executionConfig.onContentDelta?.(value.delta);
      } else {
        await executionConfig.onThinkingDelta?.(value.delta);
      }
    }

    if (!signal?.aborted) {
      await executionConfig.onStreamEnd?.();
    }

    const functionToolCalls = (chatResponse.toolCalls ?? []).filter(
      (toolCall): toolCall is FunctionToolCall => toolCall.type === 'function',
    );
    const executionPlan = planToolExecution(
      functionToolCalls,
      executionConfig.executionPipeline.getRegistry(),
      executionConfig.permissionMode,
    );

    if (signal?.aborted) {
      return { chatResponse, executionResults: [] };
    }

    const executionResults = await executeToolCalls({
      plan: executionPlan,
      executionPipeline: executionConfig.executionPipeline,
      executionContext: executionConfig.executionContext,
      logger: executionConfig.logger,
      permissionMode: executionConfig.permissionMode,
      signal,
      hooks: {
        onBeforeToolExec: executionConfig.hooks?.onBeforeToolExec,
        onUpdate: (update) => this.emitToolExecutionUpdate(executionConfig, update),
      },
    });

    return { chatResponse, executionResults };
  }

  private async dispatchReadyToolCalls(input: {
    accumulator: Map<number, ToolCallAccumulatorEntry>;
    executionResults: Array<ToolExecutionOutcome | undefined>;
    inFlightExecutions: Map<number, Promise<void>>;
    signal: AbortSignal | undefined;
    batchController: AbortController;
    executionConfig: StreamingToolExecutorConfig;
    forcePending: boolean;
  }): Promise<boolean> {
    if (input.signal?.aborted) {
      return false;
    }

    const sortedEntries = Array.from(input.accumulator.entries()).sort(
      ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
    );
    let dispatchedAny = false;

    for (const [index, entry] of sortedEntries) {
      if (!entry.id || !entry.name || entry.dispatched || entry.cancelled) {
        continue;
      }

      if (input.batchController.signal.aborted) {
        entry.cancelled = true;
        input.executionResults[index] = {
          toolCall: this.toFunctionToolCall(entry.id, entry.name, entry.arguments),
          result: this.buildCascadeAbortResult(),
          toolUseUuid: null,
        };
        await this.emitToolExecutionUpdate(input.executionConfig, {
          type: 'tool_result',
          outcome: input.executionResults[index]!,
        });
        await this.emitToolExecutionUpdate(input.executionConfig, {
          type: 'tool_completed',
          outcome: input.executionResults[index]!,
        });
        continue;
      }

      if (!input.forcePending && !this.isJsonParseable(entry.arguments)) {
        continue;
      }

      entry.dispatched = true;
      dispatchedAny = true;
      input.inFlightExecutions.set(
        index,
        this.executeToolCall({
          index,
          toolCall: this.toFunctionToolCall(entry.id, entry.name, entry.arguments),
          signal: input.signal,
          batchController: input.batchController,
          executionConfig: input.executionConfig,
          executionResults: input.executionResults,
        }),
      );
    }

    return dispatchedAny;
  }

  private async executeToolCall(input: {
    index: number;
    toolCall: FunctionToolCall;
    signal: AbortSignal | undefined;
    batchController: AbortController;
    executionConfig: StreamingToolExecutorConfig;
    executionResults: Array<ToolExecutionOutcome | undefined>;
  }): Promise<void> {
    await this.emitToolExecutionUpdate(input.executionConfig, {
      type: 'tool_ready',
      toolCall: input.toolCall,
    });

    let result: ToolResult;
    let toolUseUuid: string | null = null;

    try {
      const outcome = await runToolCall({
        toolCall: input.toolCall,
        executionPipeline: input.executionConfig.executionPipeline,
        executionContext: input.executionConfig.executionContext,
        logger: this.logger,
        permissionMode: input.executionConfig.permissionMode,
        signal: input.signal,
        batchSignal: input.batchController.signal,
        hooks: {
          onBeforeToolExec: input.executionConfig.hooks?.onBeforeToolExec,
          onUpdate: (update) => this.emitToolExecutionUpdate(input.executionConfig, update),
        },
      });
      result = outcome.result;
      toolUseUuid = outcome.toolUseUuid;
    } catch (error) {
      this.logger.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
      result = {
        success: false,
        llmContent: '',
        displayContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }

    if (
      input.toolCall.function.name === 'Bash' &&
      !result.success &&
      !input.batchController.signal.aborted &&
      !input.signal?.aborted
    ) {
      input.batchController.abort();
    }

    input.executionResults[input.index] = {
      toolCall: input.toolCall,
      result,
      toolUseUuid,
    };
  }

  private accumulateToolCall(
    accumulator: Map<number, ToolCallAccumulatorEntry>,
    chunk: StreamToolCall,
  ): void {
    const toolCallChunk = chunk as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = toolCallChunk.index ?? 0;

    if (!accumulator.has(index)) {
      accumulator.set(index, {
        id: toolCallChunk.id || '',
        name: toolCallChunk.function?.name || '',
        arguments: '',
        dispatched: false,
        cancelled: false,
      });
    }

    const entry = accumulator.get(index)!;

    if (toolCallChunk.id && !entry.id) {
      entry.id = toolCallChunk.id;
    }

    if (toolCallChunk.function?.name && !entry.name) {
      entry.name = toolCallChunk.function.name;
    }

    if (toolCallChunk.function?.arguments) {
      entry.arguments += toolCallChunk.function.arguments;
    }
  }

  private buildFinalToolCalls(
    accumulator: Map<number, ToolCallAccumulatorEntry>,
  ): ChatResponse['toolCalls'] | undefined {
    const toolCalls = Array.from(accumulator.entries())
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, toolCall]) => toolCall)
      .filter((toolCall) => toolCall.id && toolCall.name)
      .map((toolCall) => ({
        id: toolCall.id,
        type: 'function' as const,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private toFunctionToolCall(
    id: string,
    name: string,
    argumentsText: string,
  ): FunctionToolCall {
    return {
      id,
      type: 'function',
      function: {
        name,
        arguments: argumentsText,
      },
    };
  }

  private buildCascadeAbortResult(): ToolResult {
    return {
      success: false,
      llmContent: 'Tool execution cancelled because a sibling Bash tool failed',
      displayContent: 'Tool execution cancelled because a sibling Bash tool failed',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Cancelled due to sibling Bash failure',
      },
    };
  }

  private isJsonParseable(value: string): boolean {
    if (!value.trim()) {
      return false;
    }

    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  private isStreamingNotSupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const streamErrors = [
      'stream not supported',
      'streaming is not available',
      'sse not supported',
      'does not support streaming',
    ];

    return streamErrors.some((message) =>
      error.message.toLowerCase().includes(message.toLowerCase()),
    );
  }
}
