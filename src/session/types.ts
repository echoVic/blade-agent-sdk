import type { UserMessageContent } from '../agent/types.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { ContextSnapshot, RuntimeContext } from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type { ExecutionContext, ToolDefinition, ToolResult } from '../tools/types/index.js';
import type { McpServerConfig, OutputFormat, PermissionMode, ProviderType, SandboxSettings, TokenUsage } from '../types/common.js';
import { HookEvent } from '../types/constants.js';
import type { AgentLogger } from '../types/logging.js';
import type { CanUseTool, PermissionHandler, PermissionUpdate } from '../types/permissions.js';
import type { RuntimeContextPatch, RuntimePatch } from '../runtime/index.js';

export type { ExecutionContext, ProviderType, TokenUsage, ToolDefinition, ToolResult };

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  organization?: string;
  apiVersion?: string;
  projectId?: string;
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
  | { type: 'tool_progress'; id: string; name: string; message: string; sessionId: string }
  | { type: 'tool_message'; id: string; name: string; message: string; sessionId: string }
  | { type: 'tool_runtime_patch'; id: string; name: string; patch: RuntimePatch; sessionId: string }
  | { type: 'tool_context_patch'; id: string; name: string; patch: RuntimeContextPatch; sessionId: string }
  | { type: 'tool_new_messages'; id: string; name: string; messages: Message[]; sessionId: string }
  | { type: 'tool_permission_updates'; id: string; name: string; updates: PermissionUpdate[]; sessionId: string }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean; sessionId: string }
  | { type: 'usage'; usage: TokenUsage; sessionId: string }
  | { type: 'result'; subtype: 'success' | 'error'; content?: string; error?: string; sessionId: string }
  | { type: 'error'; message: string; code?: string; sessionId: string };

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

export type SessionHookEvent =
  | HookEvent.PreToolUse
  | HookEvent.PostToolUse
  | HookEvent.PostToolUseFailure
  | HookEvent.PermissionRequest
  | HookEvent.UserPromptSubmit
  | HookEvent.SessionStart
  | HookEvent.SessionEnd
  | HookEvent.TaskCompleted;



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
  toolSourcePolicy?: ToolCatalogSourcePolicy;
  mcpServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  tools?: ToolDefinition[];

  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;

  systemPrompt?: string;
  maxTurns?: number;
  agents?: Record<string, AgentDefinition>;
  subagent?: SubagentInfo;

  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;

  defaultContext?: RuntimeContext;
  logger?: AgentLogger;
  storagePath?: string;
  persistSession?: boolean;

  outputFormat?: OutputFormat;

  sandbox?: SandboxSettings;

}

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: RuntimeContext;
}

export interface StreamOptions {
  includeThinking?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContextTokens?: number;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolCount: number;
  tools?: string[];
  connectedAt?: Date;
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  serverName: string;
}

export interface ForkSessionOptions {
  messageId?: string;
}

export interface ForkSessionResult {
  sessionId: string;
  parentSessionId: string;
  messageCount: number;
  forkedAt?: string;
}

export interface ISession extends AsyncDisposable {
  readonly sessionId: string;
  readonly messages: Message[];

  send(message: UserMessageContent, options?: SendOptions): Promise<void>;

  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  close(): void;
  abort(): void;

  getDefaultContext(): RuntimeContext;
  setDefaultContext(context: RuntimeContext): void;

  setPermissionMode(mode: PermissionMode): void;
  setModel(model: string): Promise<void>;
  setMaxTurns(maxTurns: number): void;

  supportedModels(): Promise<ModelInfo[]>;

  mcpServerStatus(): Promise<McpServerStatus[]>;
  mcpConnect(serverName: string): Promise<void>;
  mcpDisconnect(serverName: string): Promise<void>;
  mcpReconnect(serverName: string): Promise<void>;
  mcpListTools(): Promise<McpToolInfo[]>;

  fork(options?: ForkSessionOptions): Promise<ISession>;
}

export type { RuntimeContext, ContextSnapshot };
