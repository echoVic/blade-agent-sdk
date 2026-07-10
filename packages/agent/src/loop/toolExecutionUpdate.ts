import type { AgentFunctionToolCall } from './planToolExecution.js';

export interface AgentToolExecutionUpdatePayloads {
  params: unknown;
  runtimePatch: unknown;
  contextPatch: unknown;
  newMessages: unknown;
  permissionUpdates: unknown;
}

export interface AgentToolExecutionOutcome<
  TToolCall = AgentFunctionToolCall,
  TResult = unknown,
> {
  toolCall: TToolCall;
  result: TResult;
  toolUseUuid: string | null;
}

export type AgentToolExecutionUpdate<
  TToolCall = AgentFunctionToolCall,
  TResult = unknown,
  TPayloads extends AgentToolExecutionUpdatePayloads = AgentToolExecutionUpdatePayloads,
  TOutcome extends AgentToolExecutionOutcome<TToolCall, TResult> = AgentToolExecutionOutcome<
    TToolCall,
    TResult
  >,
> =
  | {
      type: 'tool_ready';
      toolCall: TToolCall;
    }
  | {
      type: 'tool_started';
      toolCall: TToolCall;
      params: TPayloads['params'];
      toolUseUuid: string | null;
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
    }
  | {
      type: 'tool_result';
      outcome: TOutcome;
    }
  | {
      type: 'tool_completed';
      outcome: TOutcome;
    };
