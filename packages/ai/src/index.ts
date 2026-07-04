import type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from './model/index.js';

export type { JsonObject, JsonPrimitive, JsonValue };
export type {
  ModelMessage,
  ModelMessageRole,
  ModelOutputFormat,
  ModelPort,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition,
  UsageInfo as ModelUsageInfo,
} from './model/index.js';

export type AiProvider =
  | 'anthropic'
  | 'azure-openai'
  | 'deepseek'
  | 'gemini'
  | 'openai'
  | 'openai-compatible';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  metadata?: JsonValue;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

export type AiStreamEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; toolCall: AiToolCall }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'done'; finishReason?: string };

export interface AiModelRequest {
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: JsonObject;
  signal?: AbortSignal;
}

export interface AiModelPort {
  stream(request: AiModelRequest): AsyncIterable<AiStreamEvent>;
}

export * from './chat/index.js';
export * from './deepseek/index.js';
export * from './providers/openai-compatible/index.js';
export * from './providers/vercel/index.js';
export * from './retry/index.js';
