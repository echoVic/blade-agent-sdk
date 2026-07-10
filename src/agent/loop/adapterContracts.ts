import type { InternalLogger } from '../../logging/Logger.js';
import type { Message, ToolCall } from '@blade-ai/ai/chat';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
import type { TokenBudget } from '@blade-ai/agent/budget';
import type { TurnLimitResponse } from '../types.js';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type {
  AgentLoopAdapterConfig,
  AgentLoopAdapterHooks,
} from './agentLoop.js';
import type { ToolExecutionUpdate } from './runToolCall.js';

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
