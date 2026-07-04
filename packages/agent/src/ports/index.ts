import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
} from '@blade-ai/ai';
import type {
  AgentToolCall,
  AgentToolResult,
} from '../protocol/index.js';

export interface AgentToolPort {
  list(): Promise<readonly ModelToolDefinition[]>;
  execute(toolCall: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
}

export type AgentPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string };

export interface AgentPermissionContext {
  messages: readonly ModelMessage[];
}

export interface AgentPermissionPort {
  checkToolCall(
    toolCall: AgentToolCall,
    context: AgentPermissionContext,
    signal?: AbortSignal,
  ): Promise<AgentPermissionDecision> | AgentPermissionDecision;
}

export interface AgentHookContext {
  turnId?: string;
  step: number;
  messages: readonly ModelMessage[];
}

export interface AgentHookPort {
  beforeModel?(
    request: ModelRequest,
    context: AgentHookContext,
  ): Promise<ModelRequest> | ModelRequest;
  afterModel?(response: ModelResponse, context: AgentHookContext): Promise<void> | void;
}
