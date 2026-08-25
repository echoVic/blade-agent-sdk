import type { JSONSchema7 } from 'json-schema';
import { isHookProcessContainmentError } from '../hooks/WindowsProcessJob.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelMessage, ModelStreamToolCall, ModelToolCall } from '../model/message.js';
import type { ModelResponse, ModelService } from '../model/service.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolEffect } from '../tools/types/effects.js';
import type { ToolResult } from '../tools/types/result.js';
import { ToolErrorType } from '../tools/types/result.js';
import { isSteeringInterruptSignal } from '../types/abort.js';
import { PermissionMode } from '../types/constants.js';
import type { MessageId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { ExecutionEpoch } from './ExecutionEpoch.js';
import type { ToolExecutionOutcome } from './loop/executeToolCalls.js';
import { planToolExecution } from './loop/planToolExecution.js';
import {
  emitToolExecutionUpdate,
  runToolCall,
  type ToolExecutionContext,
  type ToolExecutionUpdate,
} from './loop/runToolCall.js';
import { streamChatResponse } from './loop/streamChatResponse.js';

interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: ModelToolCall;
    params: JsonObject;
  }) => Promise<MessageId | null>;
}

export interface StreamingToolExecutorConfig {
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  requestSignal?: AbortSignal;
  steeringSignal?: AbortSignal;
  hooks?: ToolExecutionHooks;
  onContentDelta?: (delta: string) => void | Promise<void>;
  onThinkingDelta?: (delta: string) => void | Promise<void>;
  onModelResponse?: (response: ModelResponse) => void | Promise<void>;
  onStreamEnd?: () => void | Promise<void>;
  onToolExecutionUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
  onToolReady?: (toolCall: ModelToolCall) => void | Promise<void>;
  onToolComplete?: (toolCall: ModelToolCall, result: ToolResult) => void | Promise<void>;
  onAfterToolExec?: (ctx: {
    toolCall: ModelToolCall;
    result: ToolResult;
    effects: ToolEffect[];
    toolMessageId: MessageId | null;
  }) => void | Promise<void>;
  onAfterToolExecEpochDiscard?: (ctx: {
    toolCall: ModelToolCall;
    toolMessageId: MessageId | null;
    reason: string;
  }) => Promise<void>;
}

interface ToolCallAccumulatorEntry {
  id: string;
  name: string;
  arguments: string;
  dispatched: boolean;
  dispatchedArguments?: string;
  cancelled: boolean;
}

export class StreamingToolExecutor {
  private readonly logger: InternalLogger;

  constructor(
    private readonly getModelService: () => ModelService,
    logger?: InternalLogger,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  private isEpochActive(epoch?: ExecutionEpoch): boolean {
    return !epoch || epoch.isValid;
  }

  async collectAndExecute(
    messages: readonly ModelMessage[],
    tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
  ): Promise<{
    chatResponse: ModelResponse;
    executionResults: ToolExecutionOutcome[];
  }> {
    const modelService = this.getModelService();
    const batchController = new AbortController();
    const toolCallAccumulator = new Map<number, ToolCallAccumulatorEntry>();
    const executionResults: Array<ToolExecutionOutcome | undefined> = [];
    const inFlightExecutions = new Map<number, Promise<void>>();
    let fullContent = '';
    let fullReasoningContent = '';
    let streamUsage: ModelResponse['usage'];
    let chunkCount = 0;
    let hasDispatchedTools = false;
    const shouldExecuteSerially = executionConfig.permissionMode === PermissionMode.PLAN;

    try {
      const stream = modelService.streamChat(messages, tools, signal);

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

          if (!shouldExecuteSerially) {
            hasDispatchedTools =
              (await this.dispatchReadyToolCalls({
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
        this.logger.warn('[Agent] 流式响应返回0个chunk，回退到 streamChatResponse');
        return this.collectWithFallback(messages, tools, signal, executionConfig, epoch);
      }

      const chatResponse: ModelResponse = {
        content: fullContent,
        reasoningContent: fullReasoningContent || undefined,
        toolCalls: this.buildFinalToolCalls(toolCallAccumulator),
        usage: streamUsage,
      };
      if (!signal?.aborted && this.isEpochActive(epoch)) {
        await executionConfig.onModelResponse?.(chatResponse);
        await executionConfig.onStreamEnd?.();
      }

      if (shouldExecuteSerially) {
        hasDispatchedTools =
          (await this.dispatchReadyToolCalls({
            accumulator: toolCallAccumulator,
            executionResults,
            inFlightExecutions,
            signal,
            batchController,
            executionConfig,
            forcePending: true,
            serial: true,
            epoch,
          })) || hasDispatchedTools;
      } else {
        hasDispatchedTools =
          (await this.dispatchReadyToolCalls({
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

        hasDispatchedTools =
          (await this.dispatchReadyToolCalls({
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
      }

      if (isSteeringInterruptSignal(signal)) {
        await this.completeInterruptedToolCalls(
          toolCallAccumulator,
          executionResults,
          executionConfig,
          epoch,
        );
      }

      return {
        chatResponse,
        executionResults: executionResults.filter(
          (result): result is ToolExecutionOutcome => result !== undefined,
        ),
      };
    } catch (error) {
      if (isHookProcessContainmentError(error)) {
        await Promise.allSettled(Array.from(inFlightExecutions.values()));
        throw error;
      }
      if (isSteeringInterruptSignal(signal)) {
        await this.settleInFlightExecutions(inFlightExecutions.values());
        await this.completeInterruptedToolCalls(
          toolCallAccumulator,
          executionResults,
          executionConfig,
          epoch,
        );
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
      }

      if (this.isStreamingNotSupportedError(error)) {
        this.logger.warn('[Agent] 流式请求失败，回退到 streamChatResponse');
        return this.collectWithFallback(messages, tools, signal, executionConfig, epoch);
      }

      if (hasDispatchedTools) {
        await this.settleInFlightExecutions(inFlightExecutions.values());
        this.logger.warn('[Agent] 流式响应在工具派发后失败，已等待在途工具完成并继续抛出原始错误');
      }

      throw error;
    }
  }

  private async settleInFlightExecutions(executions: Iterable<Promise<void>>): Promise<void> {
    const settled = await Promise.allSettled(Array.from(executions));
    const containmentFailure = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && isHookProcessContainmentError(result.reason),
    );
    if (containmentFailure) {
      throw containmentFailure.reason;
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

  private async collectWithFallback(
    messages: readonly ModelMessage[],
    tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
  ): Promise<{
    chatResponse: ModelResponse;
    executionResults: ToolExecutionOutcome[];
  }> {
    const stream = streamChatResponse(this.getModelService, messages, tools, signal, this.logger);
    let chatResponse: ModelResponse | undefined;
    let streamCompleted = false;
    try {
      while (true) {
        const { value, done } = await stream.next();
        if (done) {
          chatResponse = value;
          streamCompleted = true;
          break;
        }

        if (!this.isEpochActive(epoch)) break;

        if (value.type === 'content_delta') {
          await executionConfig.onContentDelta?.(value.delta);
        } else {
          await executionConfig.onThinkingDelta?.(value.delta);
        }
      }
    } finally {
      if (!streamCompleted) {
        await stream.return(undefined as never);
      }
    }

    if (chatResponse && !signal?.aborted && this.isEpochActive(epoch)) {
      await executionConfig.onModelResponse?.(chatResponse);
      await executionConfig.onStreamEnd?.();
    }

    const functionToolCalls = (chatResponse?.toolCalls ?? []).filter(
      (toolCall): toolCall is ModelToolCall => toolCall.type === 'function',
    );
    const executionPlan = planToolExecution(functionToolCalls, executionConfig.permissionMode);

    if (signal?.aborted || !this.isEpochActive(epoch)) {
      // steering 中断（stepSignal 触发但请求本身未 abort）时，chatResponse 仍可能
      // 携带 toolCalls。若此处直接返回空 executionResults，AgentLoop 会因“声明了
      // 工具调用却没有对应结果”而抛错。为每个已规划的工具调用补一个合成的
      // INTERRUPTED 结果，保持 tool_call/tool_result 配对完整。
      const interruptedResults = isSteeringInterruptSignal(signal)
        ? await this.synthesizeInterruptedResults(executionPlan.calls, executionConfig, epoch)
        : [];
      return {
        chatResponse: chatResponse ?? { content: '', toolCalls: undefined, usage: undefined },
        executionResults: interruptedResults,
      };
    }

    // 复用 StreamingToolExecutor 自身的 epoch-aware executeToolCall()，
    // 而非走外部 executeToolCalls() 路径——确保 onAfterToolExecEpochDiscard 可达。
    const batchController = new AbortController();
    const executionResults: Array<ToolExecutionOutcome | undefined> = [];
    const allCalls = executionPlan.calls;

    const executeOne = (index: number, toolCall: ModelToolCall) =>
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
    } else {
      await Promise.all(allCalls.map((toolCall, index) => executeOne(index, toolCall)));
    }

    if (!chatResponse) {
      throw new Error('Stream completed without producing a chat response');
    }

    return {
      chatResponse,
      executionResults: executionResults.filter((r): r is ToolExecutionOutcome => r !== undefined),
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
    serial?: boolean;
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
          effects: [],
          toolMessageId: null,
        };
        input.executionResults[index] = outcome;
        await this.emitToolExecutionUpdate(
          input.executionConfig,
          {
            type: 'tool_result',
            outcome,
          },
          input.epoch,
        );
        await this.emitToolExecutionUpdate(
          input.executionConfig,
          {
            type: 'tool_completed',
            outcome,
          },
          input.epoch,
        );
        continue;
      }

      if (!input.forcePending && !this.isJsonParseable(entry.arguments)) {
        continue;
      }

      entry.dispatched = true;
      entry.dispatchedArguments = entry.arguments;
      dispatchedAny = true;
      const execution = this.executeToolCall({
        index,
        toolCall: this.toFunctionToolCall(entry.id, entry.name, entry.arguments),
        signal: input.signal,
        batchController: input.batchController,
        executionConfig: input.executionConfig,
        executionResults: input.executionResults,
        epoch: input.epoch,
      });
      // The stream loop may not await this promise until a later chunk. Mark
      // rejection as observed now; the original promise remains rejected and
      // is inspected by the synchronization paths.
      void execution.catch(() => {});
      input.inFlightExecutions.set(index, execution);
      if (input.serial) {
        await execution;
      }
    }

    return dispatchedAny;
  }

  private async executeToolCall(input: {
    index: number;
    toolCall: ModelToolCall;
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
        effects: [],
        toolMessageId: null,
      };
      input.executionResults[input.index] = outcome;
      await this.emitToolExecutionUpdate(
        input.executionConfig,
        {
          type: 'tool_result',
          outcome,
        },
        input.epoch,
      );
      await this.emitToolExecutionUpdate(
        input.executionConfig,
        {
          type: 'tool_completed',
          outcome,
        },
        input.epoch,
      );
      return;
    }

    const outcome = await runToolCall({
      toolCall: input.toolCall,
      executionPipeline: input.executionConfig.executionPipeline,
      executionContext: input.executionConfig.executionContext,
      logger: this.logger,
      permissionMode: input.executionConfig.permissionMode,
      signal: input.executionConfig.requestSignal ?? input.signal,
      steeringSignal: input.executionConfig.steeringSignal,
      batchSignal: input.batchController.signal,
      hooks: {
        onBeforeToolExec: input.executionConfig.hooks?.onBeforeToolExec,
        onUpdate: (update) =>
          this.emitToolExecutionUpdate(input.executionConfig, update, input.epoch),
      },
    });
    const { result, effects, toolMessageId } = outcome;

    // Epoch guard: 工具执行完后检查 epoch 是否仍有效
    if (!this.isEpochActive(input.epoch)) {
      // 不写真实结果，补写合成 error 闭合持久化链路
      await input.executionConfig.onAfterToolExecEpochDiscard?.({
        toolCall: input.toolCall,
        toolMessageId,
        reason: 'Discarded: execution epoch invalidated',
      });
      return;
    }

    if (
      input.toolCall.function.name === 'Bash' &&
      result.status === 'error' &&
      !input.batchController.signal.aborted &&
      !input.signal?.aborted
    ) {
      input.batchController.abort();
    }

    input.executionResults[input.index] = {
      toolCall: input.toolCall,
      result,
      effects,
      toolMessageId,
    };
  }

  private accumulateToolCall(
    accumulator: Map<number, ToolCallAccumulatorEntry>,
    chunk: ModelStreamToolCall,
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
        dispatchedArguments: undefined,
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
  ): ModelResponse['toolCalls'] | undefined {
    const toolCalls = Array.from(accumulator.entries())
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, toolCall]) => toolCall)
      .filter((toolCall) => toolCall.id && toolCall.name)
      .map((toolCall) => ({
        id: toolCall.id,
        type: 'function' as const,
        function: {
          name: toolCall.name,
          arguments: toolCall.dispatchedArguments ?? toolCall.arguments,
        },
      }));

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private toFunctionToolCall(id: string, name: string, argumentsText: string): ModelToolCall {
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
      status: 'error',
      model: 'Tool execution cancelled because a sibling Bash tool failed',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Cancelled due to sibling Bash failure',
      },
    };
  }

  private async completeInterruptedToolCalls(
    accumulator: Map<number, ToolCallAccumulatorEntry>,
    executionResults: Array<ToolExecutionOutcome | undefined>,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
  ): Promise<void> {
    const entries = Array.from(accumulator.entries()).sort(
      ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
    );
    for (const [index, entry] of entries) {
      if (executionResults[index] || !entry.id || !entry.name) {
        continue;
      }
      const outcome: ToolExecutionOutcome = {
        toolCall: this.toFunctionToolCall(
          entry.id,
          entry.name,
          entry.dispatchedArguments ?? entry.arguments,
        ),
        result: {
          status: 'error',
          model: 'Tool execution interrupted by newer user input',
          error: {
            type: ToolErrorType.INTERRUPTED,
            message: 'Interrupted by newer user input',
          },
        },
        effects: [],
        toolMessageId: null,
      };
      executionResults[index] = outcome;
      if (!entry.dispatched) {
        await this.emitToolExecutionUpdate(
          executionConfig,
          {
            type: 'tool_ready',
            toolCall: outcome.toolCall,
          },
          epoch,
        );
      }
      await this.emitToolExecutionUpdate(
        executionConfig,
        {
          type: 'tool_result',
          outcome,
        },
        epoch,
      );
      await this.emitToolExecutionUpdate(
        executionConfig,
        {
          type: 'tool_completed',
          outcome,
        },
        epoch,
      );
    }
  }

  /**
   * fallback 路径下无 accumulator，直接依据已规划的工具调用为每个调用合成一个
   * INTERRUPTED 结果，并逐个发出 ready/result/completed 事件，使 steering 中断
   * 时的 tool_call/tool_result 配对与主流式路径保持一致。
   */
  private async synthesizeInterruptedResults(
    calls: readonly ModelToolCall[],
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
  ): Promise<ToolExecutionOutcome[]> {
    const outcomes: ToolExecutionOutcome[] = [];
    for (const toolCall of calls) {
      const outcome: ToolExecutionOutcome = {
        toolCall,
        result: {
          status: 'error',
          model: 'Tool execution interrupted by newer user input',
          error: {
            type: ToolErrorType.INTERRUPTED,
            message: 'Interrupted by newer user input',
          },
        },
        effects: [],
        toolMessageId: null,
      };
      outcomes.push(outcome);
      await this.emitToolExecutionUpdate(
        executionConfig,
        {
          type: 'tool_ready',
          toolCall: outcome.toolCall,
        },
        epoch,
      );
      await this.emitToolExecutionUpdate(
        executionConfig,
        {
          type: 'tool_result',
          outcome,
        },
        epoch,
      );
      await this.emitToolExecutionUpdate(
        executionConfig,
        {
          type: 'tool_completed',
          outcome,
        },
        epoch,
      );
    }
    return outcomes;
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
