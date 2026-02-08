import type { Message } from '../services/ChatServiceInterface.js';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../tools/types/index.js';
import type { McpServerConfig, PermissionMode } from '../types/common.js';
import type { CanUseTool } from '../types/permissions.js';

export type { ToolDefinition, ToolExecutionContext, ToolResult };

export type ProviderType =
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'azure-openai'
  | 'antigravity'
  | 'copilot';

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  duration: number;
  isError?: boolean;
}

export interface PromptResult {
  result: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  duration: number;
  turnsCount: number;
}

export type StreamMessage =
  | { type: 'turn_start'; turn: number; sessionId: string }
  | { type: 'turn_end'; turn: number; sessionId: string }
  | { type: 'content'; delta: string; sessionId: string }
  | { type: 'thinking'; delta: string; sessionId: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; sessionId: string }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean; sessionId: string }
  | { type: 'usage'; usage: TokenUsage; sessionId: string }
  | { type: 'result'; subtype: 'success' | 'error'; content?: string; error?: string; sessionId: string }
  | { type: 'error'; message: string; code?: string; sessionId: string };

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCompleted'
  | 'Notification'
  | 'Compaction';

export interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  error?: Error;
  sessionId: string;
  [key: string]: unknown;
}

export interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  modifiedInput?: unknown;
  modifiedOutput?: unknown;
  reason?: string;
}

export type HookCallback = (input: HookInput) => Promise<HookOutput>;

export interface ConfirmationRequest {
  toolName: string;
  toolInput: unknown;
  description: string;
  risk: 'low' | 'medium' | 'high';
}

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  remember?: boolean;
}

export type ConfirmationHandler = (
  request: ConfirmationRequest
) => Promise<ConfirmationResponse>;

export interface InteractionHandlers {
  onConfirmation?: ConfirmationHandler;
  onInput?: (prompt: string) => Promise<string>;
  onSelect?: (options: string[], prompt: string) => Promise<string>;
}

export interface SubagentInfo {
  parentSessionId: string;
  subagentType: string;
  depth: number;
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}



export interface SessionOptions {
  provider: ProviderConfig;
  model: string;

  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  tools?: ToolDefinition[];

  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;

  systemPrompt?: string;
  maxTurns?: number;
  agents?: Record<string, AgentDefinition>;
  subagent?: SubagentInfo;

  hooks?: Partial<Record<HookEvent, HookCallback[]>>;

  /** @deprecated Use canUseTool instead */
  handlers?: InteractionHandlers;

  cwd?: string;
  env?: Record<string, string>;
}

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
}

export interface StreamOptions {
  includeThinking?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxTokens?: number;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}

export interface ISession {
  readonly sessionId: string;
  readonly messages: Message[];

  send(message: string, options?: SendOptions): Promise<void>;

  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  close(): void;
  abort(): void;

  setPermissionMode(mode: PermissionMode): void;
  setModel(model: string): Promise<void>;
  setMaxTurns(maxTurns: number): void;

  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;

  [Symbol.asyncDispose](): Promise<void>;
}
