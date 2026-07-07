import type { JsonObject, JsonValue } from '@blade-ai/ai';
import type { AgentFunctionToolCall } from './planToolExecution.js';

export interface RepairToolCallParamsOptions {
  createId?: () => string;
}

export async function repairToolCallParams(
  toolCall: AgentFunctionToolCall,
  params: JsonObject,
  options: RepairToolCallParamsOptions = {},
): Promise<void> {
  if (
    toolCall.function.name === 'Task'
    && (typeof params.subagent_session_id !== 'string' || params.subagent_session_id.length === 0)
  ) {
    params.subagent_session_id =
      typeof params.resume === 'string' && params.resume.length > 0
        ? params.resume
        : (options.createId?.() ?? createDefaultSubagentSessionId());
  }

  if (typeof params.todos === 'string') {
    try {
      params.todos = JSON.parse(params.todos) as JsonValue;
    } catch {
      // Let the validation layer handle malformed todos payloads.
    }
  }
}

function createDefaultSubagentSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `subagent-${Date.now()}-${Math.random()}`;
}
