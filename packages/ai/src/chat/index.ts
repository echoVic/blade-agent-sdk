import type { JSONSchema7 } from 'json-schema';
import type { AiProvider, JsonValue } from '../index.js';
import type { QuerySource, RetryConfig, RetryEvent } from '../retry/index.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OutputFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: JSONSchema7;
    strict?: boolean;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface ProviderOptions {
  anthropic?: {
    cacheControl?: AnthropicCacheControl;
  };
  deepseek?: {
    thinking?: {
      type?: 'enabled' | 'disabled';
    };
    strictTools?: boolean;
    cacheOptimization?: {
      enabled?: boolean;
      stableMetadataKey?: string;
      stableMetadataValue?: JsonValue;
    };
  };
}

export interface TextContentPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ContentPart = TextContentPart | ImageContentPart;

export type Message = {
  id?: string;
  role: MessageRole;
  content: string | ContentPart[];
  reasoningContent?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  metadata?: JsonValue;
};

export interface ChatConfig {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  timeout?: number;
  apiVersion?: string;
  supportsThinking?: boolean;
  providerOptions?: ProviderOptions;
  customHeaders?: Record<string, string>;
  providerId?: string;
  outputFormat?: OutputFormat;
  retry?: Partial<RetryConfig>;
}

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
}

export interface ChatResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  usage?: UsageInfo;
}

export interface SideQueryOptions {
  maxOutputTokens?: number;
  temperature?: number;
  querySource?: QuerySource;
}

export type StreamToolCall = ToolCall | StreamDeltaToolCall;

export interface StreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCalls?: StreamToolCall[];
  finishReason?: string;
  usage?: UsageInfo;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

export interface IChatService {
  chat(
    messages: readonly Message[],
    tools?: ChatToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ChatResponse>;

  sideQuery(
    messages: readonly Message[],
    signal?: AbortSignal,
    options?: SideQueryOptions,
  ): Promise<ChatResponse>;

  streamChat(
    messages: readonly Message[],
    tools?: ChatToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk, void, unknown>;

  chatWithRetryEvents?(
    messages: readonly Message[],
    tools?: ChatToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<RetryEvent, ChatResponse>;

  getConfig(): ChatConfig;

  updateConfig(newConfig: Partial<ChatConfig>): void;
}
