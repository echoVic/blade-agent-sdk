import type { Message, ToolCall } from '@blade-ai/ai/chat';
import type { TokenBudget } from '@blade-ai/agent/budget';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type {
  ToolExecutionUpdateOf as SdkToolExecutionUpdate,
} from '@blade-ai/agent-sdk/tools';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipelineLike } from '@blade-ai/agent-sdk/local';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
import type { TurnLimitResponse } from '../types.js';
import type {
  AgentLoopAdapterConfig,
  AgentLoopAdapterHooks,
} from './agentLoop.js';

export type ToolExecutionUpdate = SdkToolExecutionUpdate<FunctionToolCall>;

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
  ExecutionPipelineLike,
  InternalLogger,
  TokenBudget,
  AgentLoopHooks
>;
