export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface ToolMessageMetadata {
  toolName: string;
  phase: 'start' | 'complete';
  summary?: string;
  detail?: string;
  params?: Record<string, unknown>;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown> | ToolMessageMetadata;
  thinkingContent?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxContextTokens: number;
}

export interface PendingCommand {
  displayText: string;
  text: string;
  images: Array<{ id: number; base64: string; mimeType: string }>;
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; id: number; base64: string; mimeType: string }
  >;
}

export interface SubagentProgress {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  currentTool?: string;
  startTime: number;
}

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'gemini'
  | 'deepseek'
  | 'openai-compatible'
  | 'copilot'
  | 'antigravity';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  supportsThinking?: boolean;
}

export interface McpServerConfig {
  command: string;
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

export enum PermissionMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
  BYPASSALL = 'bypassAll',
  PLAN = 'plan',
  SPEC = 'spec',
}

export interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

export interface BladeConfig {
  models: ModelConfig[];
  currentModelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: PermissionsConfig;
  theme?: string;
  language?: string;
  debug?: boolean | string;
  temperature?: number;
  maxTurns?: number;
}

export interface RuntimeConfig extends BladeConfig {
  permissionMode: PermissionMode;
  projectRoot: string;
  globalConfigDir: string;
}
