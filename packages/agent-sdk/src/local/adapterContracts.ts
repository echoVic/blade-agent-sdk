import type { Message, ToolCall } from '@blade-ai/ai/chat';
import type { TokenBudget } from '@blade-ai/agent/budget';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type {
  ToolExecutionUpdateOf as SdkToolExecutionUpdate,
} from '../tools/types/index.js';
import type { InternalLogger } from './Logger.js';
import type { ExecutionPipelineLike } from './kernelAdapterTypes.js';
import type { ToolResult } from '../tools/types/index.js';
import type { AgentEvent } from './agentEvent.js';
import type { ConversationState } from '@blade-ai/agent';
import type { TurnState } from './turnState.js';
import type { TurnLimitResponse } from './agentTypes.js';
import type {
  AgentLoopAdapterConfig,
  AgentLoopAdapterHooks,
} from '@blade-ai/agent/loop';

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
