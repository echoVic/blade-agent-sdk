import type { UserMessageContent } from '../agent/types.js';
import type { SessionId } from '../types/branded.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { ContextSnapshot, RuntimeContext, RuntimeContextPatch, RuntimePatch } from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type { ExecutionContext, ToolDefinition, ToolResult } from '../tools/types/index.js';
import type { JsonObject, JsonValue, McpServerConfig, OutputFormat, PermissionMode, ProviderType, SandboxSettings, TokenUsage } from '../types/common.js';
import { HookEvent, type StreamMessageType } from '../types/constants.js';
import type { AgentLogger } from '../types/logging.js';
import type { CanUseTool, PermissionHandler, PermissionUpdate } from '../types/permissions.js';
import type { Assert, IsEqual } from '../types/typeAssertions.js';

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
  input: JsonValue;
  output: string | object;
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
  | { type: 'turn_start'; turn: number; sessionId: SessionId }
  | { type: 'turn_end'; turn: number; sessionId: SessionId }
  | { type: 'content'; delta: string; sessionId: SessionId }
  | { type: 'thinking'; delta: string; sessionId: SessionId }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: SessionId }
  | { type: 'tool_progress'; id: string; name: string; message: string; sessionId: SessionId }
  | { type: 'tool_message'; id: string; name: string; message: string; sessionId: SessionId }
  | { type: 'tool_runtime_patch'; id: string; name: string; patch: RuntimePatch; sessionId: SessionId }
  | { type: 'tool_context_patch'; id: string; name: string; patch: RuntimeContextPatch; sessionId: SessionId }
  | { type: 'tool_new_messages'; id: string; name: string; messages: Message[]; sessionId: SessionId }
  | { type: 'tool_permission_updates'; id: string; name: string; updates: PermissionUpdate[]; sessionId: SessionId }
  | { type: 'tool_result'; id: string; name: string; output: string | object; isError?: boolean; sessionId: SessionId }
  | { type: 'usage'; usage: TokenUsage; sessionId: SessionId }
  | { type: 'result'; subtype: 'success' | 'error'; content?: string; error?: string; sessionId: SessionId }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };

type _AssertStreamMessageComplete = Assert<IsEqual<StreamMessage['type'], StreamMessageType>>;

export interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: string | object;
  error?: Error;
  sessionId: SessionId;
  [key: string]: unknown;
}

export interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  /**
   * For PreToolUse hooks: a JsonObject to merge into tool input params.
   * For UserPromptSubmit hooks: either a JsonObject with a `userPrompt`
   * key, or a bare string (legacy form) that replaces the prompt text.
   */
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
}

export type HookCallback = (input: HookInput) => Promise<HookOutput>;

export type SessionHookEvent =
  | typeof HookEvent.PreToolUse
  | typeof HookEvent.PostToolUse
  | typeof HookEvent.PostToolUseFailure
  | typeof HookEvent.PermissionRequest
  | typeof HookEvent.UserPromptSubmit
  | typeof HookEvent.SessionStart
  | typeof HookEvent.SessionEnd
  | typeof HookEvent.TaskCompleted;



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
  sessionId: SessionId;
  parentSessionId: string;
  messageCount: number;
  forkedAt?: string;
}

export interface ISession extends AsyncDisposable {
  readonly sessionId: SessionId;
  readonly messages: Message[];
  readonly isClosed: boolean;

  send(message: UserMessageContent, options?: SendOptions): Promise<void>;

  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  close(): Promise<void>;
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

export type { ContextSnapshot, RuntimeContext };
