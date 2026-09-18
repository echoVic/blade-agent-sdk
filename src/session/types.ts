import type Type from 'typebox';
import type { AgentSessionRepository } from '../agent/subagents/AgentSessionRepository.js';
import type { TokenBudgetConfig } from '../agent/TokenBudget.js';
import type { UserMessageContent } from '../agent/types.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { AgentMiddlewareConfig, AgentPlugin } from '../middleware/AgentPlugin.js';
import type {
  ModelProviderOptions,
  OutputFormat,
  ProviderConnectionConfig,
} from '../model/config.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { TokenUsage } from '../model/usage.js';
import type { AgentTrace, ObservabilityOptions } from '../observability/index.js';
import type {
  ContextSnapshot,
  RuntimeContext,
  RuntimeContextPatch,
  RuntimePatch,
} from '../runtime/index.js';
import type { SandboxSettings } from '../sandbox/config.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import type { SkillDefinition } from '../skills/types.js';
import type { WebFetchSecurityPolicy } from '../tools/builtin/web/index.js';
import type { ToolSourcePolicy } from '../tools/registry/ToolRegistry.js';
import type { ToolServiceName } from '../tools/services.js';
import type { ConfirmationHandler } from '../tools/types/execution.js';
import type {
  ToolDisplayContent,
  ToolMessage,
  ToolModelContent,
  ToolProgress,
} from '../tools/types/result.js';
import type { ToolDefinition } from '../tools/types/tool.js';
import type { HookEvent, PermissionMode, SessionStreamEventType } from '../types/constants.js';
import type {
  EventSequence,
  InputId,
  MessageId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../types/identifiers.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type { AgentLogger } from '../types/logging.js';
import type {
  PermissionHandler,
  PermissionsConfig,
  PermissionUpdate,
} from '../types/permissions.js';
import type { Assert, IsEqual } from '../types/typeAssertions.js';
import type { DurableEventStore } from './events/DurableEventStore.js';
import type {
  DurableEventSubscription,
  DurableEventSubscriptionOptions,
} from './events/DurableEventSubscription.js';
import type { DurableExecutionLeaseOptions } from './events/DurableExecutionLease.js';
import type {
  DurableExecutionLease as DurableExecutionLeaseSnapshot,
  DurableExecutionLeaseStore,
} from './events/DurableExecutionLeaseStore.js';
import type {
  DurableSessionProjection,
  DurableSessionRecoveryPlan,
} from './events/DurableSessionProjector.js';
import type { SessionEventStore, SessionRepository } from './SessionRepository.js';

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

export interface ToolExecutionRecord {
  id: ToolUseId;
  name: string;
  input: JsonValue;
  output: ToolModelContent;
  duration: number;
  isError?: boolean;
}

export interface PromptResult {
  result: string;
  toolCalls: ToolExecutionRecord[];
  usage: TokenUsage;
  duration: number;
  turnsCount: number;
}

type SessionToolEvent = {
  id: ToolUseId;
  name: string;
  sessionId: SessionId;
} & (
  | { type: 'tool_use'; input: JsonValue }
  | { type: 'tool_progress'; progress: ToolProgress }
  | { type: 'tool_message'; content: ToolMessage['content'] }
  | { type: 'tool_runtime_patch'; patch: RuntimePatch }
  | { type: 'tool_context_patch'; patch: RuntimeContextPatch }
  | { type: 'tool_new_messages'; messages: ConversationMessage[] }
  | { type: 'tool_permission_updates'; updates: PermissionUpdate[] }
  | {
      type: 'tool_result';
      output: ToolModelContent;
      display?: ToolDisplayContent;
      isError?: boolean;
    }
);

export type SessionStreamEvent =
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
  | SessionToolEvent
  | { type: 'usage'; usage: TokenUsage; sessionId: SessionId }
  | {
      type: 'result';
      subtype: 'success' | 'error';
      content?: string;
      error?: string;
      sessionId: SessionId;
    }
  | { type: 'error'; message: string; code?: string; sessionId: SessionId };

type _AssertStreamMessageComplete = Assert<
  IsEqual<SessionStreamEvent['type'], SessionStreamEventType>
>;

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
  modifiedInput?: JsonObject;
  modifiedOutput?: JsonValue;
  reason?: string;
}

export type HookCallback = (input: HookInput) => Promise<HookOutput>;

export type SessionHookEvent = HookEvent;

export interface SubagentInfo {
  parentSessionId: SessionId;
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
  provider: ProviderConnectionConfig;
  providerRegistry?: ProviderRegistry;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  providerOptions?: ModelProviderOptions;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  tokenBudget?: TokenBudgetConfig;

  allowedTools?: string[];
  disallowedTools?: string[];
  toolSourcePolicy?: ToolSourcePolicy;
  mcpServers?: Record<string, McpServerConfig | SdkMcpServerHandle>;
  memoryManager?: MemoryManager;
  tools?: readonly ToolDefinition<Type.TSchema, JsonValue, ToolServiceName, boolean>[];

  permissionMode?: PermissionMode;
  permissionHandler?: PermissionHandler;
  /**
   * Static permission rules matched against each tool invocation's permission
   * signature (`<Tool>` or `<Tool>:<detail>`, for example `Bash:npm ls`). A rule is
   * either an exact signature or a prefix ending in `*`. Invocations that match an
   * `allow` rule skip the confirmation prompt; everything else keeps the default
   * behaviour of asking.
   */
  permissions?: PermissionsConfig;
  confirmationHandler?: ConfirmationHandler;
  confirmationHandlerFactory?: (sessionId: SessionId) => ConfirmationHandler;

  systemPrompt?: string;
  maxTurns?: number;
  toolTimeoutMs?: number;
  webFetch?: WebFetchSecurityPolicy;
  agents?: Record<string, AgentDefinition>;
  skills?: readonly SkillDefinition[];
  subagent?: SubagentInfo;

  hooks?: Partial<Record<SessionHookEvent, HookCallback[]>>;
  hookTimeoutMs?: number;
  sessionEndHookTimeoutMs?: number;
  middleware?: AgentMiddlewareConfig;
  plugins?: readonly AgentPlugin[];

  defaultContext?: RuntimeContext;
  logger?: AgentLogger;
  storagePath?: string;
  persistSession?: boolean;
  sessionRepository?: SessionRepository;
  sessionEventStore?: SessionEventStore;
  durableEventStore?: DurableEventStore;
  durableExecutionLeaseStore?: DurableExecutionLeaseStore;
  agentSessionRepository?: AgentSessionRepository;
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
  messageId?: MessageId;
}

export interface ForkSessionResult {
  sessionId: SessionId;
  parentSessionId: SessionId;
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
  readonly messages: ConversationMessage[];
  readonly isClosed: boolean;

  send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission>;
  getPendingInputs(): readonly PendingSessionInput[];
  cancelInput(inputId: InputId): Promise<boolean>;

  stream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent>;

  close(): Promise<void>;
  abort(): Promise<void>;
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
  subscribeDurableEvents(
    options?: DurableEventSubscriptionOptions,
  ): Promise<DurableEventSubscription>;
}

export type { ContextSnapshot, RuntimeContext };
