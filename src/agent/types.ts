import type { AgentMiddlewareConfig } from '../middleware/AgentPlugin.js';
import type { OutputFormat } from '../model/config.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ContextSnapshot } from '../runtime/index.js';
import type { SandboxSettings } from '../sandbox/config.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import type { DurableExecutionFence } from '../session/events/DurableExecutionLeaseStore.js';
import type { ToolSourcePolicy } from '../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler, ToolExecutionLifecycle } from '../tools/types/execution.js';
import type { PermissionMode } from '../types/constants.js';
import type { AgentId, InputId, RequestId, SessionId } from '../types/identifiers.js';
import type { PermissionHandler, PermissionsConfig } from '../types/permissions.js';
import type { AgentRunControl, AgentSteeringInput } from './AgentRunControl.js';
import type { InitialInputPreparation } from './InitialInputPreparation.js';
import type { ModelExecutionLifecycle } from './ModelExecutionLifecycle.js';
import type { AgentSession } from './subagents/AgentSessionStore.js';
import type { StartBackgroundAgentOptions } from './subagents/BackgroundAgentManager.js';
import type { TokenBudgetConfig, TokenBudgetSnapshot } from './TokenBudget.js';
import type { UserMessageContent } from './UserMessageContent.js';

export type { UserMessageContent } from './UserMessageContent.js';

export interface InputApplicationLifecycle {
  onInputApplying(input: Pick<AgentSteeringInput, 'inputId' | 'priority'>): Promise<void>;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: string;
  summary?: string;
  updatedAt: number;
}

export interface IBackgroundAgentReader {
  getAgent(agentId: AgentId): Promise<AgentSession | undefined>;
  getOwnerSessionId?(): SessionId | undefined;
  isRunning(agentId: AgentId): boolean;
  waitForCompletion(agentId: AgentId, timeout?: number): Promise<AgentSession | undefined>;
}

export interface IBackgroundAgentController {
  killAgent(agentId: AgentId): Promise<boolean>;
  startBackgroundAgent(options: StartBackgroundAgentOptions): Promise<string>;
  resumeAgent(agentId: AgentId, newPrompt: string, ...args: unknown[]): Promise<string | undefined>;
}

export interface IBackgroundAgentManager
  extends IBackgroundAgentReader,
    IBackgroundAgentController {
  getMiddleware?(): AgentMiddlewareConfig;
  getProviderRegistry?(): ProviderRegistry | undefined;
}

interface SubagentInfoForContext {
  parentSessionId: SessionId;
  subagentType: string;
  isSidechain: boolean;
}

export interface AgentConversationState {
  messages: ConversationMessage[];
  userId: string;
  sessionId: SessionId;
  snapshot?: ContextSnapshot;
}

export interface AgentExecutionControl {
  signal?: AbortSignal;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface AgentExecutionServices {
  systemPrompt?: string;
  subagentInfo?: SubagentInfoForContext;
  omitEnvironment?: boolean;
  backgroundAgentManager?: IBackgroundAgentManager;
}

export type AgentExecutionContext = AgentConversationState &
  AgentExecutionControl &
  AgentExecutionServices;

export interface AgentRuntimeOptions {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissions?: Partial<PermissionsConfig>;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  toolWhitelist?: string[];
  toolSourcePolicy?: ToolSourcePolicy;
  modelId?: string;
  permissionHandler?: PermissionHandler;
  outputFormat?: OutputFormat;
  sandbox?: SandboxSettings;
  tokenBudget?: TokenBudgetConfig;
  localDiscovery?: boolean;
}

export interface LoopOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  inputApplication?: {
    inputId: InputId;
    requestId: RequestId;
  };
  prepareInput?: (input: UserMessageContent) => Promise<UserMessageContent>;
  runControl?: AgentRunControl;
  toolExecutionLifecycle?: ToolExecutionLifecycle;
  inputApplicationLifecycle?: InputApplicationLifecycle;
  modelExecutionLifecycle?: ModelExecutionLifecycle;
  initialInputPreparation?: InitialInputPreparation;
  onTurnLimitReached?: (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
}

export interface TurnLimitResponse {
  continue: boolean;
  reason?: string;
}

export interface LoopResult {
  success: boolean;
  finalMessage?: string;
  error?: {
    type:
      | 'canceled'
      | 'max_turns_exceeded'
      | 'api_error'
      | 'loop_detected'
      | 'aborted'
      | 'chat_disabled'
      | 'budget_exhausted';
    message: string;
    details?: unknown;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed?: number;
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
    hitSafetyLimit?: boolean;
    shouldExitLoop?: boolean;
    targetMode?: PermissionMode;
    planContent?: string;
    tokenBudgetSnapshot?: TokenBudgetSnapshot;
  };
}

export interface PlanApprovalResult extends LoopResult {
  metadata: LoopResult['metadata'] & {
    targetMode: PermissionMode;
    planContent?: string;
  };
}

export function isPlanApprovalResult(r: LoopResult | undefined): r is PlanApprovalResult {
  return !!r?.metadata?.targetMode;
}
