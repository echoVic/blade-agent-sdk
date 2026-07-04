import type {
  MessageRole as MessageRoleType,
  PermissionMode as PermissionModeType,
} from './constants.js';
import {
  MessageRole as MessageRoleValue,
  PermissionMode as PermissionModeValue,
} from './constants.js';

export const MessageRole = MessageRoleValue;
export type MessageRole = MessageRoleType;

export const PermissionMode = PermissionModeValue;
export type PermissionMode = PermissionModeType;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  billableInputTokens?: number;
  reasoningTokens?: number;
}

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'gemini'
  | 'deepseek'
  | 'openai-compatible';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  providerOptions?: JsonObject;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  supportsThinking?: boolean;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  alwaysAllow?: string[];
  type?: 'stdio' | 'sse' | 'http';
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    provider: string;
    clientId?: string;
    enabled?: boolean;
  };
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}

export interface PermissionsConfig {
  allow?: string[];
  ask?: string[];
  deny?: string[];
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

interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface OutputFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: JsonSchema;
    strict?: boolean;
  };
}

export interface NetworkSandboxSettings {
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
}

interface SandboxIgnoreViolations {
  file?: string[];
  network?: string[];
}

export interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
}
