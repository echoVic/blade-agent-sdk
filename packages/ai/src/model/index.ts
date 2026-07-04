export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ModelProvider =
  | 'anthropic'
  | 'azure-openai'
  | 'deepseek'
  | 'gemini'
  | 'openai'
  | 'openai-compatible';

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  metadata?: JsonValue;
}

export interface ModelToolDefinition {
  name: string;
  description?: string;
  parameters: JsonObject;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
}

export interface ModelRequest {
  provider?: ModelProvider;
  model?: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  providerOptions?: JsonObject;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: ModelToolCall[];
  usage?: UsageInfo;
  finishReason?: string;
  raw?: JsonValue;
}

export type ModelStreamEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ModelToolCall }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'done'; response?: ModelResponse; finishReason?: string }
  | { type: 'error'; error: Error };

export interface ModelPort {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
