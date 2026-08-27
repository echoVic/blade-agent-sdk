import type { MessageRole } from '../types/constants.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { ModelProviderOptions } from './config.js';
import type { ModelIdentity } from './identity.js';

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ModelTextContent {
  type: 'text';
  text: string;
  providerOptions?: ModelProviderOptions;
}

export interface ModelImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ModelContent = ModelTextContent | ModelImageContent;

export interface ModelMessageProviderOptions {
  [provider: string]: JsonValue | undefined;
  deepseek?: JsonObject & {
    cache?: JsonValue;
  };
}

/**
 * Provider-neutral message payload.
 *
 * snake_case fields intentionally mirror provider message payloads and are
 * confined to the model boundary.
 */
export interface ModelMessage {
  id?: string;
  role: MessageRole;
  content: string | ModelContent[];
  reasoningContent?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ModelToolCall[];
  providerOptions?: ModelMessageProviderOptions;
  modelIdentity?: ModelIdentity;
}

export type ModelStreamToolCall = ModelToolCall | ModelToolCallDelta;
