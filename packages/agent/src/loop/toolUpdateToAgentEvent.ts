import type { JsonObject } from '@blade-ai/ai';
import type { AgentFunctionToolCall } from './planToolExecution.js';
import type { ToolExecutionRegistryLike, ToolKind } from './toolBehavior.js';

export interface AgentLoopToolExecutionOutcome {
  toolCall: AgentFunctionToolCall;
  result: unknown;
  toolUseUuid: string | null;
}

export type AgentLoopToolExecutionUpdate =
  | {
      type: 'tool_ready';
      toolCall: AgentFunctionToolCall;
    }
  | {
      type: 'tool_started';
      toolCall: AgentFunctionToolCall;
      params: JsonObject;
      toolUseUuid: string | null;
    }
  | {
      type: 'tool_progress';
      toolCall: AgentFunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_message';
      toolCall: AgentFunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_runtime_patch';
      toolCall: AgentFunctionToolCall;
      patch: unknown;
    }
  | {
      type: 'tool_context_patch';
      toolCall: AgentFunctionToolCall;
      patch: unknown;
    }
  | {
      type: 'tool_new_messages';
      toolCall: AgentFunctionToolCall;
      messages: unknown;
    }
  | {
      type: 'tool_permission_updates';
      toolCall: AgentFunctionToolCall;
      updates: unknown;
    }
  | {
      type: 'tool_result';
      outcome: AgentLoopToolExecutionOutcome;
    }
  | {
      type: 'tool_completed';
      outcome: AgentLoopToolExecutionOutcome;
    };

export type AgentLoopToolEvent =
  | {
      type: 'tool_start';
      toolCall: AgentFunctionToolCall;
      toolKind?: ToolKind | string;
    }
  | {
      type: 'tool_result';
      toolCall: AgentFunctionToolCall;
      result: unknown;
    }
  | {
      type: 'tool_progress';
      toolCall: AgentFunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_message';
      toolCall: AgentFunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_runtime_patch';
      toolCall: AgentFunctionToolCall;
      patch: unknown;
    }
  | {
      type: 'tool_context_patch';
      toolCall: AgentFunctionToolCall;
      patch: unknown;
    }
  | {
      type: 'tool_new_messages';
      toolCall: AgentFunctionToolCall;
      messages: unknown;
    }
  | {
      type: 'tool_permission_updates';
      toolCall: AgentFunctionToolCall;
      updates: unknown;
    };

export function toolUpdateToAgentEvent(
  update: AgentLoopToolExecutionUpdate,
  registry: ToolExecutionRegistryLike,
): AgentLoopToolEvent | null {
  switch (update.type) {
    case 'tool_ready': {
      const toolDef = registry.get(update.toolCall.function.name);
      return { type: 'tool_start', toolCall: update.toolCall, toolKind: toolDef?.kind };
    }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCall: update.outcome.toolCall,
        result: update.outcome.result,
      };
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
