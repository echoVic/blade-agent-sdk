import type { TokenBudgetConfig } from '@blade-ai/agent/budget';
import type { UserMessageContent } from '../agent/types.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { AgentTrace, ObservabilityOptions } from '../observability/index.js';
import type {
  ContextSnapshot,
  RuntimeContext,
} from '../runtime/index.js';
import type { Message } from '@blade-ai/ai/chat';
import type { PromptResult, ToolCallRecord, ToolCatalogSourcePolicy } from '@blade-ai/agent-sdk/local';
import type { ExecutionContext, ToolDefinition, ToolResult } from '../tools/types/index.js';
import type { SessionId } from '../types/branded.js';
import type {
  JsonObject,
  McpServerConfig,
  OutputFormat,
  PermissionMode,
  ProviderType,
  SandboxSettings,
  TokenUsage,
} from '../types/common.js';
import type { StreamMessageType } from '../types/constants.js';
import type { AgentLogger } from '../types/logging.js';
import type { CanUseTool, PermissionHandler } from '../types/permissions.js';
import type { Assert, IsEqual } from '../types/typeAssertions.js';
import type {
  AgentDefinition,
  ForkSessionOptions,
  ForkSessionResult,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  ProviderConfig,
  SendOptions,
  StreamOptions,
  SubagentInfo,
} from '@blade-ai/agent-sdk/local';
import type {
  HookCallback,
  HookInput,
  HookOutput,
  SessionHookEvent,
} from '@blade-ai/agent-sdk/session';

export type { ExecutionContext, ProviderType, TokenUsage, ToolDefinition, ToolResult };

export type { ProviderConfig };

export type { ToolCallRecord };

export type { PromptResult };

// The canonical session stream protocol lives in @blade-ai/agent-sdk/session.
// It is a strict superset of the old root union (adds turn_start/turn_end/
// content/thinking/tool_use/tool_progress/tool_message/tool_runtime_patch/
// tool_context_patch/tool_new_messages/budget_warning/budget_exhausted).
import type { StreamMessage } from '@blade-ai/agent-sdk/session';
export type { StreamMessage };

type _AssertStreamMessageComplete = Assert<IsEqual<StreamMessage['type'], StreamMessageType>>;

export type { HookInput };

export type { HookOutput };

export type { HookCallback };

export type { SessionHookEvent };

export type { SubagentInfo };

export type { AgentDefinition };

// Slice #348: SessionOptions is canonically defined in the package session
// layer (session/types.ts); the root declaration is retired.
export type { SessionOptions } from '@blade-ai/agent-sdk/session';
export type { StreamOptions, SendOptions };

export type { ModelInfo };

export type { McpServerStatus };

export type { McpToolInfo };

export type { ForkSessionOptions, ForkSessionResult };

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
