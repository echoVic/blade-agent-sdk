import type { JSONSchema7 } from 'json-schema';
import type { ModelServiceConfig } from './config.js';
import type { ModelMessage, ModelStreamToolCall, ModelToolCall } from './message.js';
import type { ModelRetryEvent, QuerySource } from './retry.js';
import type { ModelUsage } from './usage.js';

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

export interface ModelResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: ModelToolCall[];
  usage?: ModelUsage;
}

export interface ModelSideQueryOptions {
  maxOutputTokens?: number;
  temperature?: number;
  querySource?: QuerySource;
}

export interface ModelStreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ModelStreamToolCall[];
  finishReason?: string;
  usage?: ModelUsage;
}

export interface ModelService {
  chat(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ModelResponse>;

  sideQuery(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
    options?: ModelSideQueryOptions,
  ): Promise<ModelResponse>;

  streamChat(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, unknown>;

  chatWithRetryEvents?(
    messages: readonly ModelMessage[],
    tools?: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<ModelRetryEvent, ModelResponse>;

  getConfig(): ModelServiceConfig;

  updateConfig(newConfig: Partial<ModelServiceConfig>): void;
}
