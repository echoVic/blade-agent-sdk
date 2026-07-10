import type { Message, ToolCall } from '@blade-ai/ai/chat';
import type { TokenBudget } from '@blade-ai/agent/budget';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type {
  ToolExecutionOutcomeOf as SdkToolExecutionOutcome,
  ToolExecutionUpdateOf as SdkToolExecutionUpdate,
} from '@blade-ai/agent-sdk/tools';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { SessionId } from '../../types/branded.js';
import type { BladeConfig, JsonObject, PermissionMode } from '../../types/common.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
import type { IBackgroundAgentManager, TurnLimitResponse } from '../types.js';
import type {
  AgentLoopAdapterConfig,
  AgentLoopAdapterHooks,
} from './agentLoop.js';

export type ToolExecutionOutcome = SdkToolExecutionOutcome<FunctionToolCall>;

export type ToolExecutionUpdate = SdkToolExecutionUpdate<FunctionToolCall>;

export interface ToolExecutionContext {
  sessionId: SessionId;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  toolCatalog?: ToolCatalog;
  toolRegistry?: ToolRegistry;
  discoveredTools?: string[];
}

export interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
  onToolReady?: (toolCall: FunctionToolCall) => void | Promise<void>;
  onAfterToolExec?: (ctx: ToolExecutionOutcome) => void | Promise<void>;
  onToolComplete?: (toolCall: FunctionToolCall, result: ToolResult) => void | Promise<void>;
  onUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
}

export interface RunToolCallInput {
  toolCall: FunctionToolCall;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  hooks?: ToolExecutionHooks;
  batchSignal?: AbortSignal;
}

export type RunToolCallPort = (
  input: RunToolCallInput,
) => Promise<ToolExecutionOutcome>;

export type AgentLoopHooks = AgentLoopAdapterHooks<
  Message,
  AgentEvent,
  FunctionToolCall,
  ToolCall,
  ToolResult,
  ToolExecutionUpdate,
  TurnLimitResponse
>;

export type AgentLoopConfig = AgentLoopAdapterConfig<
  ConversationState,
  TurnState,
  ExecutionPipeline,
  InternalLogger,
  TokenBudget,
  AgentLoopHooks
>;
