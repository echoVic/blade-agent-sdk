import type { JsonObject } from '@blade-ai/ai';
import type { AgentFunctionToolCall } from './planToolExecution.js';
import type { ToolExecutionRegistryLike, ToolKind } from './toolBehavior.js';
import type {
  AgentToolExecutionOutcome,
  AgentToolExecutionUpdate,
  AgentToolExecutionUpdatePayloads,
} from './toolExecutionUpdate.js';

export interface AgentLoopToolExecutionOutcome extends AgentToolExecutionOutcome {}

export type AgentLoopToolExecutionUpdate = AgentToolExecutionUpdate<
  AgentFunctionToolCall,
  unknown,
  AgentToolExecutionUpdatePayloads & { params: JsonObject },
  AgentLoopToolExecutionOutcome
>;

export type AgentLoopToolEvent<
  TToolCall = AgentFunctionToolCall,
  TResult = unknown,
  TPayloads extends AgentToolExecutionUpdatePayloads = AgentToolExecutionUpdatePayloads,
> =
  | {
      type: 'tool_start';
      toolCall: TToolCall;
      toolKind?: ToolKind | string;
    }
  | {
      type: 'tool_result';
      toolCall: TToolCall;
      result: TResult;
    }
  | {
      type: 'tool_progress';
      toolCall: TToolCall;
      message: string;
    }
  | {
      type: 'tool_message';
      toolCall: TToolCall;
      message: string;
    }
  | {
      type: 'tool_runtime_patch';
      toolCall: TToolCall;
      patch: TPayloads['runtimePatch'];
    }
  | {
      type: 'tool_context_patch';
      toolCall: TToolCall;
      patch: TPayloads['contextPatch'];
    }
  | {
      type: 'tool_new_messages';
      toolCall: TToolCall;
      messages: TPayloads['newMessages'];
    }
  | {
      type: 'tool_permission_updates';
      toolCall: TToolCall;
      updates: TPayloads['permissionUpdates'];
    };

export interface AgentLoopToolResultEventInput<
  TResult = unknown,
  TToolCall = AgentFunctionToolCall,
> {
  toolCall: TToolCall;
  result: TResult;
}

export function buildAgentLoopToolResultEvent<
  TResult,
  TToolCall = AgentFunctionToolCall,
>(
  input: AgentLoopToolResultEventInput<TResult, TToolCall>,
): {
  type: 'tool_result';
  toolCall: TToolCall;
  result: TResult;
} {
  return {
    type: 'tool_result',
    toolCall: input.toolCall,
    result: input.result,
  };
}

export function toolUpdateToAgentEvent<
  TToolCall extends AgentFunctionToolCall,
  TResult,
  TPayloads extends AgentToolExecutionUpdatePayloads,
  TOutcome extends AgentToolExecutionOutcome<TToolCall, TResult>,
>(
  update: AgentToolExecutionUpdate<TToolCall, TResult, TPayloads, TOutcome>,
  registry: ToolExecutionRegistryLike,
): AgentLoopToolEvent<TToolCall, TResult, TPayloads> | null {
  switch (update.type) {
    case 'tool_ready': {
      const toolDef = registry.get(update.toolCall.function.name);
      return { type: 'tool_start', toolCall: update.toolCall, toolKind: toolDef?.kind };
    }
    case 'tool_result':
      return buildAgentLoopToolResultEvent({
        toolCall: update.outcome.toolCall,
        result: update.outcome.result,
      });
    case 'tool_progress':
      return {
        type: 'tool_progress',
        toolCall: update.toolCall,
        message: update.message,
      };
    case 'tool_message':
      return {
        type: 'tool_message',
        toolCall: update.toolCall,
        message: update.message,
      };
    case 'tool_runtime_patch':
      return {
        type: 'tool_runtime_patch',
        toolCall: update.toolCall,
        patch: update.patch,
      };
    case 'tool_context_patch':
      return {
        type: 'tool_context_patch',
        toolCall: update.toolCall,
        patch: update.patch,
      };
    case 'tool_new_messages':
      return {
        type: 'tool_new_messages',
        toolCall: update.toolCall,
        messages: update.messages,
      };
    case 'tool_permission_updates':
      return {
        type: 'tool_permission_updates',
        toolCall: update.toolCall,
        updates: update.updates,
      };
    case 'tool_started':
    case 'tool_completed':
      return null;
  }
}
