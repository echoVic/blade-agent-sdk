import type { TokenBudgetConfig, TokenBudgetSnapshot } from '@blade-ai/agent/budget';
export type { TokenBudgetConfig, TokenBudgetSnapshot } from '@blade-ai/agent/budget';
import type { AgentTrace, ObservabilityOptions } from '../observability/types.js';
import type {
  ContextSnapshot,
  RuntimeContext,
  RuntimeContextPatch,
  RuntimePatch,
} from '../runtime/types.js';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types/index.js';
import type {
  JsonObject,
  JsonValue,
  McpServerConfig,
  OutputFormat,
  PermissionMode,
  ProviderType,
  SandboxSettings,
  TokenUsage,
} from '../types/common.js';
import type { HookEvent } from '../types/constants.js';
import type { CanUseTool, PermissionHandler, PermissionUpdate } from '../types/permissions.js';

export type SessionId = string;
export type SessionMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type UserMessageContent = string | SessionContentPart[];

export type ToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';
export type ToolTrustLevel = 'trusted' | 'workspace' | 'remote';

export interface ToolCatalogSourcePolicy {
  allowedSources?: ToolSourceKind[];
  allowedTrustLevels?: ToolTrustLevel[];
}

export interface SdkMcpServerHandle {
  name: string;
  version: string;
  createClientTransport: () => Promise<unknown>;
  server: unknown;
}

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevelName;
  category: string;
  message: string;
  timestamp: string;
  sessionId?: string;
  args?: unknown[];
}

export interface AgentLogger {
  log(entry: LogEntry): void;
}

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

export interface SessionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SessionTextContentPart {
  type: 'text';
  text: string;
}

export interface SessionImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type SessionContentPart = SessionTextContentPart | SessionImageContentPart;

export interface SessionMessage {
  id?: string;
  role: SessionMessageRole;
  content: string | SessionContentPart[];
  reasoningContent?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: SessionToolCall[];
  metadata?: JsonValue;
}

export type StreamMessage =
  | { type: 'turn_start'; turn: number; sessionId: SessionId }
  | { type: 'turn_end'; turn: number; sessionId: SessionId }
  | { type: 'content'; delta: string; sessionId: SessionId }
  | { type: 'thinking'; delta: string; sessionId: SessionId }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: SessionId }
  | { type: 'tool_progress'; id: string; name: string; message: string; sessionId: SessionId }
  | { type: 'tool_message'; id: string; name: string; message: string; sessionId: SessionId }
  | {
      type: 'tool_runtime_patch';
      id: string;
      name: string;
      patch: RuntimePatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_context_patch';
      id: string;
      name: string;
      patch: RuntimeContextPatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_new_messages';
      id: string;
      name: string;
      messages: SessionMessage[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_permission_updates';
      id: string;
      name: string;
      updates: PermissionUpdate[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      output: string | object;
      isError?: boolean;
      sessionId: SessionId;
    }
  | { type: 'usage'; usage: TokenUsage; sessionId: SessionId }
  | { type: 'budget_warning'; snapshot: TokenBudgetSnapshot; sessionId: SessionId }
  | { type: 'budget_exhausted'; snapshot: TokenBudgetSnapshot; sessionId: SessionId }
  | {
      type: 'result';
      subtype: 'success' | 'error';
      content?: string;
      error?: string;
      sessionId: SessionId;
    }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: RuntimeContext;
}

export interface StreamOptions {
  includeThinking?: boolean;
}

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

export type SessionTool = ToolDefinition<never> | Tool;

export interface SessionOptions {
  provider: ProviderConfig;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  providerOptions?: JsonObject;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  tokenBudget?: TokenBudgetConfig;

  allowedTools?: string[];
  disallowedTools?: string[];
  toolSourcePolicy?: ToolCatalogSourcePolicy;
  mcpServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  tools?: SessionTool[];

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

  observability?: ObservabilityOptions;
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
  readonly messages: SessionMessage[];
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

  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
}

export interface ResumeOptions extends SessionOptions {
  sessionId: SessionId;
}

export interface ForkOptions extends ResumeOptions {
  messageId?: string;
}

export type { ContextSnapshot, RuntimeContext, ToolDefinition, ToolResult };
