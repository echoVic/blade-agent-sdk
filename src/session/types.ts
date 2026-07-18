import type { TokenBudgetConfig } from '@blade-ai/agent/budget';
import type { UserMessageContent } from '../agent/types.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { AgentTrace, ObservabilityOptions } from '../observability/index.js';
import type {
  ContextSnapshot,
  RuntimeContext,
  RuntimeContextPatch,
  RuntimePatch,
} from '../runtime/index.js';
import type { Message } from '@blade-ai/ai/chat';
import type { PromptResult, ToolCallRecord, ToolCatalogSourcePolicy } from '@blade-ai/agent-sdk/local';
import type { ExecutionContext, ToolDefinition, ToolResult } from '../tools/types/index.js';
import type { SessionId } from '../types/branded.js';
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
import type { HookEvent, StreamMessageType } from '../types/constants.js';
import type { AgentLogger } from '../types/logging.js';
import type { CanUseTool, PermissionHandler, PermissionUpdate } from '../types/permissions.js';
import type { Assert, IsEqual } from '../types/typeAssertions.js';

export type { ExecutionContext, ProviderType, TokenUsage, ToolDefinition, ToolResult };

export type { ProviderConfig };

export type { ToolCallRecord };

export type { PromptResult };

export type StreamMessage =
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
  | {
      type: 'result';
      subtype: 'success' | 'error';
      content?: string;
      error?: string;
      sessionId: SessionId;
    }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };

type _AssertStreamMessageComplete = Assert<IsEqual<StreamMessage['type'], StreamMessageType>>;

export type { HookInput } from '@blade-ai/agent-sdk/local';

export type { HookOutput } from '@blade-ai/agent-sdk/local';

export type { HookCallback } from '@blade-ai/agent-sdk/local';

export type { SessionHookEvent } from '@blade-ai/agent-sdk/local';

export type { SubagentInfo } from '@blade-ai/agent-sdk/local';

export type { AgentDefinition } from '@blade-ai/agent-sdk/local';

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
  // 使用 ToolDefinition<never> 以容纳不同 TParams 的自定义工具：execute 的参数位是逆变的，
  // 若写成 ToolDefinition<JsonObject>[]，则 defineTool<{...}>() 得到的强类型工具无法赋值进来，
  // 迫使调用方在 execute 内部做 cast。never 只用于数组元素的参数位，不泄漏到调用方的 execute。
  tools?: ToolDefinition<never>[];

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

export type { StreamOptions, SendOptions } from '@blade-ai/agent-sdk/local';

export type { ModelInfo } from '@blade-ai/agent-sdk/local';

export type { McpServerStatus } from '@blade-ai/agent-sdk/local';

export type { McpToolInfo } from '@blade-ai/agent-sdk/local';

export type { ForkSessionOptions, ForkSessionResult } from '@blade-ai/agent-sdk/local';

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

  getLastTrace(): AgentTrace | undefined;
  getTraces(): AgentTrace[];
}

export type { ContextSnapshot, RuntimeContext };
