import type {
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from '@blade-ai/ai';
import type {
  AgentHookContext,
  AgentHookPort,
  AgentPermissionPort,
  AgentToolPort,
} from '../ports/index.js';
import type {
  AgentStreamEvent,
  AgentTokenBudgetPort,
  AgentToolCall,
  AgentToolResult,
} from '../protocol/index.js';
import type {
  AgentStoreAppendContext,
  AgentStorePort,
} from '../state/index.js';
import type {
  AgentTraceEvent,
  AgentTracePort,
} from '../tracing/index.js';

export type AgentModelRequestDefaults = Partial<Pick<
  ModelRequest,
  'model' | 'maxOutputTokens' | 'temperature' | 'maxContextTokens' | 'providerOptions' | 'outputFormat'
>>;

export type AgentModelCallMode = 'generate' | 'stream';

export interface AgentKernelOptions {
  model: ModelPort;
  modelRequestDefaults?: AgentModelRequestDefaults;
  modelCallMode?: AgentModelCallMode;
  tools?: AgentToolPort;
  permissions?: AgentPermissionPort;
  trace?: AgentTracePort;
  store?: AgentStorePort;
  hooks?: AgentHookPort;
  tokenBudget?: AgentTokenBudgetPort;
  maxSteps?: number;
}

export interface AgentTurnInput {
  input: string;
  messages?: readonly ModelMessage[];
  turnId?: string;
  signal?: AbortSignal;
  maxSteps?: number;
  modelCallMode?: AgentModelCallMode;
}

const DEFAULT_MAX_STEPS = 10;

export class AgentKernel {
  constructor(readonly options: AgentKernelOptions) {}

  async *runTurn(turn: AgentTurnInput): AsyncIterable<AgentStreamEvent> {
    const inputMessage: ModelMessage = { role: 'user', content: turn.input };
    let messages: readonly ModelMessage[] = turn.messages ?? [inputMessage];
    const maxSteps = turn.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const modelCallMode = turn.modelCallMode ?? this.options.modelCallMode ?? 'generate';
    let modelSteps = 0;

    if (!turn.messages) {
      await this.appendStoreMessage(inputMessage, {
        turnId: turn.turnId,
        source: 'input',
        step: 0,
      }, turn.signal);
    }

    if (turn.signal?.aborted) {
      yield { type: 'error', code: 'ABORTED', message: 'Operation aborted' };
      return;
    }

    await this.recordTrace({ type: 'turn_start', input: turn.input });
    await this.recordTrace({ type: 'model_request', messages });
    let response = yield* this.requestModel(modelCallMode, await this.createModelRequest(messages, turn.signal), {
      turnId: turn.turnId,
      step: 1,
      messages,
    });
    modelSteps += 1;
    await this.recordModelResponse(response);

    while (response.toolCalls && response.toolCalls.length > 0) {
      if (modelSteps >= maxSteps) {
        yield {
          type: 'error',
          code: 'MAX_STEPS_EXCEEDED',
          message: 'Agent turn exceeded maxSteps',
        };
        return;
      }

      if (!this.options.tools) {
        throw new Error('Model requested tool calls, but no tool port is configured');
      }

      const toolMessages: ModelMessage[] = [];
      const assistantToolMessage = this.toolCallsToAssistantMessage(response);
      await this.appendStoreMessage(assistantToolMessage, {
        turnId: turn.turnId,
        source: 'model',
        step: modelSteps,
      }, turn.signal);

      for (const toolCall of response.toolCalls) {
        yield { type: 'tool_use', toolCall };
        await this.recordTrace({ type: 'tool_call_start', toolCall });
        const result = await this.executeToolCall(toolCall, messages, turn.signal);
        for (const effect of result.effects ?? []) {
          if (effect.type === 'permissionUpdates') {
            const event = {
              type: 'tool_permission_updates' as const,
              toolCall,
              updates: effect.updates,
            };
            await this.recordTrace(event);
            yield event;
          }
        }
        await this.recordTrace({ type: 'tool_call_end', toolCall, result });
        yield { type: 'tool_result', result };
        const toolMessage = this.toolResultToMessage(result, toolCall);
        await this.appendStoreMessage(toolMessage, {
          turnId: turn.turnId,
          source: 'tool',
          step: modelSteps,
        }, turn.signal);
        toolMessages.push(toolMessage);
      }

      messages = [
        ...messages,
        assistantToolMessage,
        ...toolMessages,
      ];
      await this.recordTrace({ type: 'model_request', messages });
      modelSteps += 1;
      response = yield* this.requestModel(modelCallMode, await this.createModelRequest(messages, turn.signal), {
        turnId: turn.turnId,
        step: modelSteps,
        messages,
      });
      await this.recordModelResponse(response);
    }

    if (modelCallMode === 'generate' && response.reasoningContent) {
      yield { type: 'thinking', delta: response.reasoningContent };
    }
    if (modelCallMode === 'generate' && response.content) {
      yield { type: 'content', delta: response.content };
    }
    if (modelCallMode === 'generate' && response.usage) {
      yield { type: 'usage', usage: response.usage };
      await this.recordTrace({ type: 'usage', usage: response.usage });
      yield* this.recordTokenBudget(response.usage);
    }
    await this.appendStoreMessage(this.responseToAssistantMessage(response), {
      turnId: turn.turnId,
      source: 'model',
      step: modelSteps,
    }, turn.signal);
    await this.recordTrace({
      type: 'turn_end',
      content: response.content,
      finishReason: response.finishReason,
    });
    yield {
      type: 'result',
      content: response.content,
      finishReason: response.finishReason,
    };
  }

  private async *requestModel(
    mode: AgentModelCallMode,
    request: ModelRequest,
    context: AgentHookContext,
  ): AsyncGenerator<AgentStreamEvent, ModelResponse> {
    if (mode === 'stream') {
      return yield* this.streamModel(request, context);
    }

    return await this.generateModel(request, context);
  }

  private async appendStoreMessage(
    message: ModelMessage,
    context: AgentStoreAppendContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.options.store?.appendMessage(message, context, signal);
  }

  private async executeToolCall(
    toolCall: AgentToolCall,
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const decision = await this.options.permissions?.checkToolCall(
      toolCall,
      { messages },
      signal,
    );

    if (decision?.behavior === 'deny') {
      return {
        id: toolCall.id,
        name: toolCall.name,
        output: decision.message ?? `Tool ${toolCall.name} was denied by permission policy`,
        isError: true,
      };
    }

    if (!this.options.tools) {
      throw new Error('Model requested tool calls, but no tool port is configured');
    }
    return this.options.tools.execute(toolCall, signal);
  }

  private toolCallsToAssistantMessage(response: ModelResponse): ModelMessage {
    return this.responseToAssistantMessage(response);
  }

  private responseToAssistantMessage(response: ModelResponse): ModelMessage {
    return {
      role: 'assistant',
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    };
  }

  private toolResultToMessage(result: AgentToolResult, toolCall: ModelToolCall): ModelMessage {
    return {
      role: 'tool',
      content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      name: result.name || toolCall.name,
      toolCallId: result.id || toolCall.id,
    };
  }

  private async recordModelResponse(response: ModelResponse): Promise<void> {
    await this.recordTrace({
      type: 'model_response',
      content: response.content,
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    });
  }

  private async recordTrace(event: AgentTraceEvent): Promise<void> {
    await this.options.trace?.record(event);
  }

  private async generateModel(
    request: ModelRequest,
    context: AgentHookContext,
  ): Promise<ModelResponse> {
    const nextRequest = await this.options.hooks?.beforeModel?.(request, context) ?? request;
    const response = await this.options.model.generate(nextRequest);
    await this.options.hooks?.afterModel?.(response, {
      ...context,
      messages: nextRequest.messages,
    });
    return response;
  }

  private async *streamModel(
    request: ModelRequest,
    context: AgentHookContext,
  ): AsyncGenerator<AgentStreamEvent, ModelResponse> {
    const nextRequest = await this.options.hooks?.beforeModel?.(request, context) ?? request;
    let content = '';
    let reasoningContent = '';
    let usage: ModelResponse['usage'];
    let finishReason: string | undefined;
    const toolCalls: ModelToolCall[] = [];
    let doneResponse: ModelResponse | undefined;

    for await (const event of this.options.model.stream(nextRequest)) {
      if (event.type === 'content_delta') {
        content += event.delta;
        yield { type: 'content', delta: event.delta };
        continue;
      }

      if (event.type === 'reasoning_delta') {
        reasoningContent += event.delta;
        yield { type: 'thinking', delta: event.delta };
        continue;
      }

      if (event.type === 'tool_call') {
        toolCalls.push(event.toolCall);
        continue;
      }

      if (event.type === 'usage') {
        usage = event.usage;
        yield { type: 'usage', usage: event.usage };
        await this.recordTrace({ type: 'usage', usage: event.usage });
        yield* this.recordTokenBudget(event.usage);
        continue;
      }

      if (event.type === 'done') {
        doneResponse = event.response ?? doneResponse;
        finishReason = event.finishReason ?? event.response?.finishReason ?? finishReason;
        continue;
      }

      yield {
        type: 'error',
        code: 'MODEL_STREAM_ERROR',
        message: event.error.message,
      };
      throw event.error;
    }

    const response: ModelResponse = doneResponse
      ? {
          ...doneResponse,
          content: doneResponse.content || content,
          ...(doneResponse.reasoningContent || reasoningContent
            ? { reasoningContent: doneResponse.reasoningContent ?? reasoningContent }
            : {}),
          ...(doneResponse.toolCalls ?? toolCalls.length > 0
            ? { toolCalls: doneResponse.toolCalls ?? toolCalls }
            : {}),
          ...(doneResponse.usage ?? usage ? { usage: doneResponse.usage ?? usage } : {}),
          finishReason: doneResponse.finishReason ?? finishReason,
        }
      : {
          content,
          ...(reasoningContent ? { reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
          ...(finishReason ? { finishReason } : {}),
        };

    await this.options.hooks?.afterModel?.(response, {
      ...context,
      messages: nextRequest.messages,
    });
    return response;
  }

  private async createModelRequest(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<ModelRequest> {
    const tools = await this.options.tools?.list();
    return {
      ...this.options.modelRequestDefaults,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      signal,
    };
  }

  private async *recordTokenBudget(
    usage: NonNullable<ModelResponse['usage']>,
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.options.tokenBudget) {
      return;
    }

    await this.options.tokenBudget.record(usage);
    if (this.options.tokenBudget.isExhausted()) {
      yield {
        type: 'budget_exhausted',
        snapshot: this.options.tokenBudget.getSnapshot(),
      };
      return;
    }
    if (
      this.options.tokenBudget.isWarning() ||
      this.options.tokenBudget.isApproachingLimit()
    ) {
      yield {
        type: 'budget_warning',
        snapshot: this.options.tokenBudget.getSnapshot(),
      };
    }
  }
}
