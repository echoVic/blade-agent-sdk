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
import type { PermissionHandler, PermissionUpdate } from '../types/permissions.js';
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
  | { type: 'tool_use'; id: ToolUseId; name: string; input: JsonValue; sessionId: SessionId }
  | {
      type: 'tool_progress';
      id: ToolUseId;
      name: string;
      progress: ToolProgress;
      sessionId: SessionId;
    }
  | {
      type: 'tool_message';
      id: ToolUseId;
      name: string;
      content: ToolMessage['content'];
      sessionId: SessionId;
    }
  | {
      type: 'tool_runtime_patch';
      id: ToolUseId;
      name: string;
      patch: RuntimePatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_context_patch';
      id: ToolUseId;
      name: string;
      patch: RuntimeContextPatch;
      sessionId: SessionId;
    }
  | {
      type: 'tool_new_messages';
      id: ToolUseId;
      name: string;
      messages: ConversationMessage[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_permission_updates';
      id: ToolUseId;
      name: string;
      updates: PermissionUpdate[];
      sessionId: SessionId;
    }
  | {
      type: 'tool_result';
      id: ToolUseId;
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
  /** Input fields to merge into tool input or prompt payload. */
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
  /** Instance-scoped custom provider adapters. */
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
  /** Enables the built-in MemoryRead and MemoryWrite tools for this Session. */
  memoryManager?: MemoryManager;
  /** Custom tool definitions returned by defineTool(). */
  tools?: readonly ToolDefinition<Type.TSchema, JsonValue, ToolServiceName, boolean>[];

  permissionMode?: PermissionMode;
  /** Full permission callback for low-level Session integrations. */
  permissionHandler?: PermissionHandler;
  confirmationHandler?: ConfirmationHandler;
  /** Creates a Session-bound confirmation handler after the Session ID exists. */
  confirmationHandlerFactory?: (sessionId: SessionId) => ConfirmationHandler;

  systemPrompt?: string;
  maxTurns?: number;
  /** Maximum wall-clock duration of one tool invocation. */
  toolTimeoutMs?: number;
  /** Network-boundary policy for the built-in WebFetch tool. */
  webFetch?: WebFetchSecurityPolicy;
  agents?: Record<string, AgentDefinition>;
  /** Session-scoped Skills supplied as data instead of discovered from disk. */
  skills?: readonly SkillDefinition[];
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
  /**
   * Shared transcript repository. Required for resumable server Sessions.
   * The /node entry creates a JSONL repository from storagePath when omitted.
   */
  sessionRepository?: SessionRepository;
  /** Write-side Session projection port paired with sessionRepository. */
  sessionEventStore?: SessionEventStore;
  durableEventStore?: DurableEventStore;
  /** Explicit Store for execution lease ownership and sticky fencing checks. */
  durableExecutionLeaseStore?: DurableExecutionLeaseStore;
  /**
   * Storage for subagent Sessions.
   *
   * Defaults to a store rooted in local storage, which cannot be reached from
   * another host. Inject one backed by the same repository as the parent Session
   * when subagents must survive a move between machines.
   */
  agentSessionRepository?: AgentSessionRepository;
  /** Maximum wall-clock duration of one durable Store call. Defaults to 15000ms. */
  durableStoreTimeoutMs?: number;
  /** Requires durableExecutionLeaseStore. */
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
