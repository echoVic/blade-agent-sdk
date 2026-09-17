import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ToolExecutionUpdate } from './runToolCall.js';

export function toolUpdateToAgentEvent(
  update: ToolExecutionUpdate,
  registry: ToolRegistry,
): AgentEvent | null {
  switch (update.type) {
    case 'tool_ready': {
      const toolDef = registry.get(update.toolCall.function.name);
      const toolKind = toolDef?.staticBehavior.kind;
      return { type: 'tool_start', toolCall: update.toolCall, toolKind };
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
        progress: update.progress,
      };
    case 'tool_message':
      return {
        type: 'tool_message',
        toolCall: update.toolCall,
        content: update.content,
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
