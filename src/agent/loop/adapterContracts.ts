import type { InternalLogger } from '../../logging/Logger.js';
import type { Message, ToolCall } from '../../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
import type { TokenBudget } from '../TokenBudget.js';
import type { TurnLimitResponse } from '../types.js';
import type {
  AgentLoopAdapterConfig,
  AgentLoopAdapterHooks,
} from './agentLoop.js';
import type { ToolExecutionUpdate } from './runToolCall.js';
import type { FunctionToolCall } from './types.js';

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
