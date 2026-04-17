/**
 * 把 ToolExecutionUpdate（内部工具事件）映射为 AgentEvent（对外事件流）。
 *
 * 原本在 AgentLoop.ts 的 streaming 分支内联了一大段 if-else，这里集中。
 * 非所有 update 都映射——tool_started/tool_completed 是内部状态，对外只透出 tool_start/tool_result。
 */
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
      const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
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
