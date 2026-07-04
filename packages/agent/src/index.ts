import type {
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
  ModelToolCall,
  ModelUsageInfo,
} from '@blade-ai/ai';

export type AgentMessageContent = string | Array<{ type: 'text'; text: string }>;

export interface AgentUserMessage {
  role: 'user';
  content: AgentMessageContent;
  metadata?: JsonValue;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

export interface AgentToolResult {
  id: string;
  name: string;
  output: string | JsonObject;
  isError?: boolean;
}

export type AgentStreamEvent =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; toolCall: AgentToolCall }
  | { type: 'tool_result'; result: AgentToolResult }
  | { type: 'usage'; usage: ModelUsageInfo }
  | { type: 'result'; content: string; finishReason?: string }
  | { type: 'error'; message: string; code?: string };

export interface AgentToolPort {
  list(): Promise<readonly ModelToolDefinition[]>;
  execute(toolCall: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
}

export type AgentPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string };

export interface AgentPermissionContext {
  messages: readonly ModelMessage[];
}

export interface AgentPermissionPort {
  checkToolCall(
    toolCall: AgentToolCall,
    context: AgentPermissionContext,
    signal?: AbortSignal,
  ): Promise<AgentPermissionDecision> | AgentPermissionDecision;
}

export type AgentTraceEvent =
  | { type: 'turn_start'; input: string }
  | { type: 'model_request'; messages: readonly ModelMessage[] }
  | {
      type: 'model_response';
      content: string;
      finishReason?: string;
      toolCalls?: readonly AgentToolCall[];
      usage?: ModelUsageInfo;
    }
  | { type: 'tool_call_start'; toolCall: AgentToolCall }
  | { type: 'tool_call_end'; toolCall: AgentToolCall; result: AgentToolResult }
  | { type: 'usage'; usage: ModelUsageInfo }
  | { type: 'turn_end'; content: string; finishReason?: string };

export interface AgentTracePort {
  record(event: AgentTraceEvent): Promise<void> | void;
}

export type AgentStoreMessageSource = 'input' | 'model' | 'tool';

export interface AgentStoreAppendContext {
  turnId?: string;
  source: AgentStoreMessageSource;
  step: number;
}

export interface AgentStorePort {
  appendMessage(
    message: ModelMessage,
    context: AgentStoreAppendContext,
    signal?: AbortSignal,
  ): Promise<void> | void;
}

export interface AgentHookContext {
  turnId?: string;
  step: number;
  messages: readonly ModelMessage[];
}

export interface AgentHookPort {
  beforeModel?(request: ModelRequest, context: AgentHookContext): Promise<ModelRequest> | ModelRequest;
  afterModel?(response: ModelResponse, context: AgentHookContext): Promise<void> | void;
}

export type AgentModelRequestDefaults = Partial<Pick<
  ModelRequest,
  'model' | 'maxOutputTokens' | 'temperature' | 'maxContextTokens' | 'providerOptions' | 'outputFormat'
>>;

export interface AgentKernelOptions {
  model: ModelPort;
  modelRequestDefaults?: AgentModelRequestDefaults;
  tools?: AgentToolPort;
  permissions?: AgentPermissionPort;
  trace?: AgentTracePort;
  store?: AgentStorePort;
  hooks?: AgentHookPort;
  maxSteps?: number;
}

export interface AgentTurnInput {
  input: string;
  messages?: readonly ModelMessage[];
  turnId?: string;
  signal?: AbortSignal;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 10;

export class AgentKernel {
  constructor(readonly options: AgentKernelOptions) {}

  async *runTurn(turn: AgentTurnInput): AsyncIterable<AgentStreamEvent> {
    if (turn.signal?.aborted) {
      yield { type: 'error', code: 'ABORTED', message: 'Operation aborted' };
      return;
    }

    const inputMessage: ModelMessage = { role: 'user', content: turn.input };
    let messages: readonly ModelMessage[] = turn.messages ?? [inputMessage];
    const maxSteps = turn.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let modelSteps = 0;

    if (!turn.messages) {
      await this.appendStoreMessage(inputMessage, {
        turnId: turn.turnId,
        source: 'input',
        step: 0,
      }, turn.signal);
    }

    await this.recordTrace({ type: 'turn_start', input: turn.input });
    await this.recordTrace({ type: 'model_request', messages });
    let response = await this.generateModel(await this.createModelRequest(messages, turn.signal), {
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
      response = await this.generateModel(await this.createModelRequest(messages, turn.signal), {
        turnId: turn.turnId,
        step: modelSteps,
        messages,
      });
      await this.recordModelResponse(response);
    }

    if (response.reasoningContent) {
      yield { type: 'thinking', delta: response.reasoningContent };
    }
    if (response.content) {
      yield { type: 'content', delta: response.content };
    }
    if (response.usage) {
      yield { type: 'usage', usage: response.usage };
      await this.recordTrace({ type: 'usage', usage: response.usage });
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
}
