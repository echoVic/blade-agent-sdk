import type {
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelPort,
  ModelResponse,
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
  list(): Promise<AgentToolCall[]>;
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

export interface AgentKernelOptions {
  model: ModelPort;
  tools?: AgentToolPort;
  permissions?: AgentPermissionPort;
}

export interface AgentTurnInput {
  input: string;
  messages?: readonly ModelMessage[];
  signal?: AbortSignal;
}

export class AgentKernel {
  constructor(readonly options: AgentKernelOptions) {}

  async *runTurn(turn: AgentTurnInput): AsyncIterable<AgentStreamEvent> {
    let messages: readonly ModelMessage[] = turn.messages ?? [
      { role: 'user', content: turn.input },
    ];

    let response = await this.options.model.generate({
      messages,
      signal: turn.signal,
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      if (!this.options.tools) {
        throw new Error('Model requested tool calls, but no tool port is configured');
      }

      const toolMessages: ModelMessage[] = [];
      for (const toolCall of response.toolCalls) {
        yield { type: 'tool_use', toolCall };
        const result = await this.executeToolCall(toolCall, messages, turn.signal);
        yield { type: 'tool_result', result };
        toolMessages.push(this.toolResultToMessage(result, toolCall));
      }

      messages = [
        ...messages,
        this.toolCallsToAssistantMessage(response),
        ...toolMessages,
      ];
      response = await this.options.model.generate({
        messages,
        signal: turn.signal,
      });
    }

    if (response.reasoningContent) {
      yield { type: 'thinking', delta: response.reasoningContent };
    }
    if (response.content) {
      yield { type: 'content', delta: response.content };
    }
    if (response.usage) {
      yield { type: 'usage', usage: response.usage };
    }
    yield {
      type: 'result',
      content: response.content,
      finishReason: response.finishReason,
    };
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
    return {
      role: 'assistant',
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      toolCalls: response.toolCalls ?? [],
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
}
