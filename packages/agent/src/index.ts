import type { AiModelPort, AiUsage, JsonObject, JsonValue } from '@blade-ai/ai';

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
  | { type: 'usage'; usage: AiUsage }
  | { type: 'result'; content: string }
  | { type: 'error'; message: string; code?: string };

export interface AgentToolPort {
  list(): Promise<AgentToolCall[]>;
  execute(toolCall: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
}

export interface AgentKernelOptions {
  model: AiModelPort;
  tools?: AgentToolPort;
}

export class AgentKernel {
  constructor(readonly options: AgentKernelOptions) {}
}
