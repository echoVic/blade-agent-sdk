import type { TokenBudgetConfig } from '../agent/TokenBudget.js';
import type { UserMessageContent } from '../agent/types.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { AgentMiddlewareConfig, AgentPlugin } from '../middleware/AgentPlugin.js';
import type { AgentTrace, ObservabilityOptions } from '../observability/index.js';
import type {
  ContextSnapshot,
  RuntimeContext,
  RuntimeContextPatch,
  RuntimePatch,
} from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import type { ToolCatalogSourcePolicy } from '../tools/catalog/index.js';
import type {
  ExecutionContext,
  Tool,
  ToolDefinition,
  ToolDisplayContent,
  ToolInvocation,
  ToolMessage,
  ToolModelContent,
  ToolProgress,
  ToolResult,
} from '../tools/types/index.js';
import type { EventSequence, InputId, RequestId, SessionId } from '../types/branded.js';
import type {
  BuiltinProviderType,
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
import type { DurableEventStore } from './events/DurableEventStore.js';
import type { DurableExecutionLeaseOptions } from './events/DurableExecutionLease.js';
import type { DurableExecutionLease as DurableExecutionLeaseSnapshot } from './events/DurableExecutionLeaseStore.js';
import type {
  DurableEventSubscription,
  DurableEventSubscriptionOptions,
} from './events/DurableEventSubscription.js';
import type {
  DurableSessionProjection,
  DurableSessionRecoveryPlan,
} from './events/DurableSessionProjector.js';

export type {
  AgentMiddlewareConfig,
  AgentPlugin,
  BuiltinProviderType,
  ExecutionContext,
  ProviderType,
  TokenUsage,
  ToolDefinition,
  ToolResult,
};

export const InputPriority = {
  NOW: 'now',
  NEXT: 'next',
  LATER: 'later',
} as const;

export type InputPriority = (typeof InputPriority)[keyof typeof InputPriority];

export type InputSubmission =
  | {
      status: 'started';
      inputId: InputId;
      requestId: RequestId;
    }
  | {
      status: 'steered';
      inputId: InputId;
      requestId: RequestId;
      priority: 'now' | 'next';
    }
  | {
      status: 'queued';
      inputId: InputId;
      priority: 'later';
    };

export interface PendingSessionInput {
  inputId: InputId;
  content: UserMessageContent;
  priority: InputPriority;
  targetRequestId?: RequestId;
  acceptedAt: number;
}

export interface ProviderConfig {
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

export interface ToolCallRecord {
  id: string;
  name: string;
  input: JsonValue;
  output: ToolModelContent;
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
  | {
      type: 'turn_interrupted';
      inputId: InputId;
      requestId: RequestId;
      turn: number;
      sessionId: SessionId;
    }
  | {
      type: 'input_applied';
      inputId: InputId;
      requestId: RequestId;
      priority: 'now' | 'next';
      turn: number;
      sessionId: SessionId;
    }
  | { type: 'content'; delta: string; sessionId: SessionId }
  | { type: 'thinking'; delta: string; sessionId: SessionId }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue; sessionId: SessionId }
  | {
      type: 'tool_progress';
      id: string;
      name: string;
      progress: ToolProgress;
      sessionId: SessionId;
    }
  | {
      type: 'tool_message';
      id: string;
      name: string;
      content: ToolMessage['content'];
      sessionId: SessionId;
    }
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
      messages: Message[];
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
      output: ToolModelContent;
      display?: ToolDisplayContent;
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

export interface HookInput {
  event: HookEvent;
  abortSignal?: AbortSignal;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: ToolModelContent;
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

// Existential Tool shape for heterogeneous arrays. The concrete parameter type
// remains enforced where each Tool is created.
type ErasedTool = Omit<Tool<never>, 'build'> & {
  build(params: never): ToolInvocation<unknown>;
};

export type SessionTool = ToolDefinition<never> | ErasedTool;

export interface SessionOptions {
  provider: ProviderConfig;
  /** Instance-scoped custom provider adapters. */
  providerRegistry?: ProviderRegistry;
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
  // never 用于擦除异构工具的参数类型，不会泄漏到各工具自己的 execute 实现。
  tools?: SessionTool[];

  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  canUseTool?: CanUseTool;

  systemPrompt?: string;
  maxTurns?: number;
  /** Maximum wall-clock duration of one tool invocation. */
  toolTimeoutMs?: number;
  agents?: Record<string, AgentDefinition>;
  subagent?: SubagentInfo;

  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
  /** Total deadline for one inline hook event. Defaults to 600000ms. */
  hookTimeoutMs?: number;
  /** Deadline for inline SessionEnd hooks. Defaults to 3000ms. */
  sessionEndHookTimeoutMs?: number;
  middleware?: AgentMiddlewareConfig;
  plugins?: readonly AgentPlugin[];

  defaultContext?: RuntimeContext;
  logger?: AgentLogger;
  storagePath?: string;
  persistSession?: boolean;
  durableEventStore?: DurableEventStore;
  /** Maximum wall-clock duration of one durable Store call. Defaults to 15000ms. */
  durableStoreTimeoutMs?: number;
  executionLease?: DurableExecutionLeaseOptions;

  outputFormat?: OutputFormat;

  sandbox?: SandboxSettings;

  observability?: ObservabilityOptions;
}

export interface SendOptions {
  signal?: AbortSignal;
  maxTurns?: number;
  context?: RuntimeContext;
  priority?: InputPriority;
  expectedRequestId?: RequestId;
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

export interface SessionHandoffResult {
  readonly sessionId: SessionId;
  readonly headSequence: EventSequence;
  readonly recoveryPlan: DurableSessionRecoveryPlan;
}

export interface ISession extends AsyncDisposable {
  readonly sessionId: SessionId;
  readonly messages: Message[];
  readonly isClosed: boolean;

  send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission>;
  getPendingInputs(): readonly PendingSessionInput[];
  cancelInput(inputId: InputId): Promise<boolean>;

  stream(options?: StreamOptions): AsyncGenerator<StreamMessage>;

  /** Close after active cleanup and durable finalization when durableEventStore is configured. */
  close(): Promise<void>;
  /** Abort after active cleanup and durable finalization when durableEventStore is configured. */
  abort(): Promise<void>;
  /** Stop local execution without terminalizing the durable Session so another worker can recover it. */
  suspendForHandoff(): Promise<SessionHandoffResult>;

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
  getDurableProjection(): DurableSessionProjection | null;
  getDurableRecoveryPlan(): DurableSessionRecoveryPlan | null;
  getExecutionLease(): DurableExecutionLeaseSnapshot | null;
  /** Replays durable events from an optional cursor and then follows live commits. */
  subscribeDurableEvents(
    options?: DurableEventSubscriptionOptions,
  ): Promise<DurableEventSubscription>;
}

export type { ContextSnapshot, RuntimeContext };
