import type { ConversationMessage } from '../model/conversation.js';
import type { ModelToolCall } from '../model/message.js';
import type { TokenUsage } from '../model/usage.js';
import type { RuntimeContextPatch, RuntimePatch } from '../runtime/index.js';
import type { ToolMessage, ToolProgress, ToolResult } from '../tools/types/result.js';
import type { InputId, RequestId } from '../types/identifiers.js';
import type { PermissionUpdate } from '../types/permissions.js';
import type { TokenBudgetSnapshot } from './TokenBudget.js';

export interface CompactingEvent {
  type: 'compacting';
  isCompacting: boolean;
}

type ToolEvent =
  | { type: 'tool_start'; toolCall: ModelToolCall; toolKind?: 'readonly' | 'write' | 'execute' }
  | { type: 'tool_result'; toolCall: ModelToolCall; result: ToolResult }
  | { type: 'tool_progress'; toolCall: ModelToolCall; progress: ToolProgress }
  | { type: 'tool_message'; toolCall: ModelToolCall; content: ToolMessage['content'] }
  | { type: 'tool_runtime_patch'; toolCall: ModelToolCall; patch: RuntimePatch }
  | { type: 'tool_context_patch'; toolCall: ModelToolCall; patch: RuntimeContextPatch }
  | { type: 'tool_new_messages'; toolCall: ModelToolCall; messages: ConversationMessage[] }
  | {
      type: 'tool_permission_updates';
      toolCall: ModelToolCall;
      updates: PermissionUpdate[];
    };

export type AgentEvent =
  | { type: 'agent_start' | 'agent_end' | 'stream_end' }
  | { type: 'turn_start'; turn: number; maxTurns: number }
  | { type: 'turn_end'; turn: number; hasToolCalls: boolean }
  | { type: 'turn_retry'; turn: number; reason: 'reactive_compact' }
  | {
      type: 'input_applied';
      inputId: InputId;
      requestId: RequestId;
      priority: 'now' | 'next';
      turn: number;
    }
  | { type: 'turn_interrupted'; inputId: InputId; requestId: RequestId; turn: number }
  | { type: 'content_delta' | 'thinking_delta'; delta: string }
  | { type: 'thinking'; content: string }
  | ToolEvent
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'budget_warning'; snapshot: TokenBudgetSnapshot }
  | CompactingEvent
  | {
      type: 'api_retry';
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: { status?: number; message: string };
    }
  | { type: 'model_fallback'; originalModel: string; fallbackModel: string }
  | { type: 'error'; message: string }
  | {
      type: 'recovery';
      phase: 'started' | 'retrying' | 'failed';
      reason: 'context_overflow' | 'reactive_compact' | 'recovery_exhausted';
    };
