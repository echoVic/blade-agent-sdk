import type { JsonObject, JsonValue } from '../types/json.js';
import type { ModelRetryConfig } from './retry.js';

export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'azure-openai',
  'gemini',
  'deepseek',
  'openai-compatible',
] as const;

export type BuiltinProviderType = (typeof PROVIDER_TYPES)[number];
export type ProviderType = BuiltinProviderType | (string & {});

export function isBuiltinProviderType(value: string): value is BuiltinProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

export interface ModelProviderOptions {
  [provider: string]: JsonValue | undefined;
  anthropic?: JsonObject & {
    cacheControl?: JsonObject & {
      type: 'ephemeral';
    };
  };
  deepseek?: JsonObject & {
    thinking?: JsonObject & {
      type?: 'enabled' | 'disabled';
    };
    strictTools?: boolean;
    cacheOptimization?: JsonObject & {
      enabled?: boolean;
      stableMetadataKey?: string;
      stableMetadataValue?: JsonValue;
    };
  };
}

export interface OutputFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
    };
    strict?: boolean;
  };
}

interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number | boolean | null)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  /** Logical provider ID. Adapter selection depends only on `provider`. */
  providerId?: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** Maximum wall-clock wait for a non-streaming model operation. */
  requestTimeoutMs?: number;
  /** Maximum wait between model stream chunks. */
  streamIdleTimeoutMs?: number;
  headers?: Record<string, string>;
  providerOptions?: ModelProviderOptions;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  supportsThinking?: boolean;
}

export interface ModelServiceConfig
  extends Pick<
    ModelConfig,
    | 'provider'
    | 'providerId'
    | 'model'
    | 'temperature'
    | 'maxContextTokens'
    | 'maxOutputTokens'
    | 'requestTimeoutMs'
    | 'streamIdleTimeoutMs'
    | 'providerOptions'
  > {
  apiKey: string;
  baseUrl: string;
  customHeaders?: Record<string, string>;
  apiVersion?: string;
  supportsThinking?: boolean;
  outputFormat?: OutputFormat;
  retry?: Partial<ModelRetryConfig>;
}

export interface ProviderConnectionConfig {
  /** Logical provider ID. Defaults to `type`. */
  id?: string;
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
  /** Maximum wall-clock wait for a non-streaming model operation. */
  requestTimeoutMs?: number;
  /** Maximum wait between model stream chunks. */
  streamIdleTimeoutMs?: number;
}
