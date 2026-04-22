import type { MessageRole as MessageRoleType } from './constants.js';
import { MessageRole as MessageRoleValue } from './constants.js';

export const MessageRole = MessageRoleValue;
export type MessageRole = MessageRoleType;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
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

import type { PermissionMode as PermissionModeType } from './constants.js';
import { PermissionMode as PermissionModeValue } from './constants.js';

export const PermissionMode = PermissionModeValue;
export type PermissionMode = PermissionModeType;

export interface PermissionsConfig {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface BladeConfig {
  models: ModelConfig[];
  currentModelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  inProcessMcpServerNames?: string[];
  permissions?: PermissionsConfig;
  theme?: string;
  language?: string;
  debug?: boolean | string;
  temperature?: number;
  maxTurns?: number;
  /**
   * Plan 文件的保存目录。
   * 不配置时 ExitPlanMode 工具不会将计划写入磁盘。
   * 对应 Claude Agent SDK 的 plansDirectory 配置项。
   */
  plansDirectory?: string;
  /**
   * SDK 数据存储根目录（会话历史、skills、agents、snapshots、OAuth tokens 等）。
   * 不配置时各存储功能优雅降级（跳过持久化）。
   * 上层应用自行指定，例如 path.join(os.homedir(), '.blade')。
   */
  storageRoot?: string;
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
