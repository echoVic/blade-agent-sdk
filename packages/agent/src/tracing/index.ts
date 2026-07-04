import type { ModelMessage, ModelUsageInfo } from '@blade-ai/ai';
import type {
  AgentPermissionUpdate,
  AgentToolCall,
  AgentToolResult,
} from '../protocol/index.js';

export type AgentTraceEvent =
  | { type: 'turn_start'; input: string }
  | { type: 'model_request'; messages: readonly ModelMessage[] }
  | {
      type: 'model_response';
      content: string;
      finishReason?: string;
      toolCalls?: readonly AgentToolCall[];
      usage?: ModelUsageInfo;
    }
  | { type: 'tool_call_start'; toolCall: AgentToolCall }
  | {
      type: 'tool_permission_updates';
      toolCall: AgentToolCall;
      updates: readonly AgentPermissionUpdate[];
    }
  | { type: 'tool_call_end'; toolCall: AgentToolCall; result: AgentToolResult }
  | { type: 'usage'; usage: ModelUsageInfo }
  | { type: 'turn_end'; content: string; finishReason?: string };

export interface AgentTracePort {
  record(event: AgentTraceEvent): Promise<void> | void;
}
