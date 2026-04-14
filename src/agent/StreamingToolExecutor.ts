import type { JSONSchema7 } from 'json-schema';
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
import type { JsonObject, PermissionMode } from '../types/common.js';
import type { ExecutionEpoch } from './ExecutionEpoch.js';
import { type ToolExecutionOutcome } from './loop/executeToolCalls.js';
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
    params: JsonObject;
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
  onAfterToolExecEpochDiscard?: (ctx: {
    toolCall: FunctionToolCall;
    toolUseUuid: string | null;
    reason: string;
  }) => Promise<void>;
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

  private isEpochActive(epoch?: ExecutionEpoch): boolean {
    return !epoch || epoch.isValid;
  }

  async collectAndExecute(
    messages: readonly Message[],
    tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
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
          if (this.isEpochActive(epoch)) {
            await executionConfig.onContentDelta?.(chunk.content);
          }
        }

        if (chunk.reasoningContent) {
          fullReasoningContent += chunk.reasoningContent;
          if (this.isEpochActive(epoch)) {
            await executionConfig.onThinkingDelta?.(chunk.reasoningContent);
          }
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
            epoch,
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
        return this.collectWithWrappedHandler(messages, tools, signal, executionConfig, epoch);
      }

      if (!signal?.aborted && this.isEpochActive(epoch)) {
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
        epoch,
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
        epoch,
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
        return this.collectWithWrappedHandler(messages, tools, signal, executionConfig, epoch);
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
    epoch?: ExecutionEpoch,
  ): Promise<void> {
    if (!this.isEpochActive(epoch)) return;
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
    messages: readonly Message[],
    tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
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

      if (!this.isEpochActive(epoch)) break;

      if (value.type === 'content_delta') {
        await executionConfig.onContentDelta?.(value.delta);
      } else {
        await executionConfig.onThinkingDelta?.(value.delta);
      }
    }

    if (!signal?.aborted && this.isEpochActive(epoch)) {
      await executionConfig.onStreamEnd?.();
    }

    const functionToolCalls = (chatResponse?.toolCalls ?? []).filter(
      (toolCall): toolCall is FunctionToolCall => toolCall.type === 'function',
    );
    const executionPlan = planToolExecution(
      functionToolCalls,
      executionConfig.executionPipeline.getRegistry(),
      executionConfig.permissionMode,
    );

    if (signal?.aborted || !this.isEpochActive(epoch)) {
      return {
        chatResponse: chatResponse ?? { content: '', toolCalls: undefined, usage: undefined },
        executionResults: [],
      };
    }

    // 复用 StreamingToolExecutor 自身的 epoch-aware executeToolCall()，
    // 而非走外部 executeToolCalls() 路径——确保 onAfterToolExecEpochDiscard 可达。
    const batchController = new AbortController();
    const executionResults: Array<ToolExecutionOutcome | undefined> = [];
    const allCalls = executionPlan.calls;
    const MAX_CONCURRENCY = 5;

    const executeOne = (index: number, toolCall: FunctionToolCall) =>
      this.executeToolCall({
        index,
        toolCall,
        signal,
        batchController,
        executionConfig,
        executionResults,
        epoch,
      });

    if (executionPlan.mode === 'serial') {
      for (let i = 0; i < allCalls.length; i++) {
        if (!this.isEpochActive(epoch)) break;
        await executeOne(i, allCalls[i]);
      }
    } else if (executionPlan.mode === 'mixed') {
      const groups = executionPlan.groups ?? allCalls.map((tc) => [tc]);
      let globalIndex = 0;
      for (const group of groups) {
        if (!this.isEpochActive(epoch)) break;
        await this.executeWithConcurrencyLimit(
          group, MAX_CONCURRENCY,
          (toolCall) => executeOne(globalIndex++, toolCall),
        );
      }
    } else {
      // parallel
      await this.executeWithConcurrencyLimit(
        allCalls, MAX_CONCURRENCY,
        (toolCall, i) => executeOne(i, toolCall),
      );
    }

    if (!chatResponse) {
      throw new Error('Stream completed without producing a chat response');
    }

    return {
      chatResponse,
      executionResults: executionResults.filter(
        (r): r is ToolExecutionOutcome => r !== undefined,
      ),
    };
  }

  private async dispatchReadyToolCalls(input: {
    accumulator: Map<number, ToolCallAccumulatorEntry>;
    executionResults: Array<ToolExecutionOutcome | undefined>;
    inFlightExecutions: Map<number, Promise<void>>;
    signal: AbortSignal | undefined;
    batchController: AbortController;
    executionConfig: StreamingToolExecutorConfig;
    forcePending: boolean;
    epoch?: ExecutionEpoch;
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

      // Epoch guard: 不在已失效的 epoch 中派发新工具
      if (!this.isEpochActive(input.epoch)) {
        continue;
      }

      if (input.batchController.signal.aborted) {
        entry.cancelled = true;
        const outcome: ToolExecutionOutcome = {
          toolCall: this.toFunctionToolCall(entry.id, entry.name, entry.arguments),
          result: this.buildCascadeAbortResult(),
          toolUseUuid: null,
        };
        input.executionResults[index] = outcome;
        await this.emitToolExecutionUpdate(input.executionConfig, {
          type: 'tool_result',
          outcome,
        }, input.epoch);
        await this.emitToolExecutionUpdate(input.executionConfig, {
          type: 'tool_completed',
          outcome,
        }, input.epoch);
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
          epoch: input.epoch,
        }),
      );
    }

    return dispatchedAny;
  }

  /**
   * 复刻 executeToolCalls.ts 的 executeWithConcurrency 语义：
   * worker-pool 模式，最多 maxConcurrency 个并发 worker。
   */
  private async executeWithConcurrencyLimit<T>(
    items: T[],
    maxConcurrency: number,
    executor: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(maxConcurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        await executor(items[currentIndex], currentIndex);
      }
    });
    await Promise.all(workers);
  }

  private async executeToolCall(input: {
    index: number;
    toolCall: FunctionToolCall;
    signal: AbortSignal | undefined;
    batchController: AbortController;
    executionConfig: StreamingToolExecutorConfig;
    executionResults: Array<ToolExecutionOutcome | undefined>;
    epoch?: ExecutionEpoch;
  }): Promise<void> {
    // Layer 1 防御性 guard：epoch 失效后不启动新工具执行
    if (!this.isEpochActive(input.epoch)) {
      return;
    }

    // Layer 1b 防御性 guard：batch 已 abort（如 Bash 失败）后，
    // 写 cascade-abort result 而非启动新工具执行，与主流式路径 dispatchReadyToolCalls 语义一致。
    if (input.batchController.signal.aborted) {
      const outcome: ToolExecutionOutcome = {
        toolCall: input.toolCall,
        result: this.buildCascadeAbortResult(),
        toolUseUuid: null,
      };
      input.executionResults[input.index] = outcome;
      await this.emitToolExecutionUpdate(input.executionConfig, {
        type: 'tool_result',
        outcome,
      }, input.epoch);
      await this.emitToolExecutionUpdate(input.executionConfig, {
        type: 'tool_completed',
        outcome,
      }, input.epoch);
      return;
    }

    await this.emitToolExecutionUpdate(input.executionConfig, {
      type: 'tool_ready',
      toolCall: input.toolCall,
    }, input.epoch);

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
          onUpdate: (update) => this.emitToolExecutionUpdate(input.executionConfig, update, input.epoch),
        },
      });
      result = outcome.result;
      toolUseUuid = outcome.toolUseUuid;
    } catch (error) {
      this.logger.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
      result = {
        success: false,
        llmContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }

    // Epoch guard: 工具执行完后检查 epoch 是否仍有效
    if (!this.isEpochActive(input.epoch)) {
      // 不写真实结果，补写合成 error 闭合持久化链路
      await input.executionConfig.onAfterToolExecEpochDiscard?.({
        toolCall: input.toolCall,
        toolUseUuid,
        reason: 'Discarded: execution epoch invalidated',
      });
      return;
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

    let entry = accumulator.get(index);

    if (!entry) {
      entry = {
        id: toolCallChunk.id || '',
        name: toolCallChunk.function?.name || '',
        arguments: '',
        dispatched: false,
        cancelled: false,
      };
      accumulator.set(index, entry);
    }

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
