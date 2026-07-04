import type {
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelPort,
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

export interface AgentKernelOptions {
  model: ModelPort;
  tools?: AgentToolPort;
}

export interface AgentTurnInput {
  input: string;
  messages?: readonly ModelMessage[];
  signal?: AbortSignal;
}

export class AgentKernel {
  constructor(readonly options: AgentKernelOptions) {}

  async *runTurn(turn: AgentTurnInput): AsyncIterable<AgentStreamEvent> {
    const messages: readonly ModelMessage[] = turn.messages ?? [
      { role: 'user', content: turn.input },
    ];

    const response = await this.options.model.generate({
      messages,
      signal: turn.signal,
    });

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
}
