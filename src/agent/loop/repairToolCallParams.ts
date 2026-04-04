import type { FunctionToolCall } from './types.js';

export async function repairToolCallParams(
  toolCall: FunctionToolCall,
  params: Record<string, unknown>,
): Promise<void> {
  if (
    toolCall.function.name === 'Task'
    && (typeof params.subagent_session_id !== 'string' || params.subagent_session_id.length === 0)
  ) {
    const { nanoid } = await import('nanoid');
    params.subagent_session_id =
      typeof params.resume === 'string' && params.resume.length > 0
        ? params.resume
        : nanoid();
  }

  if (typeof params.todos === 'string') {
    try {
      params.todos = JSON.parse(params.todos) as unknown;
    } catch {
      // Let the validation layer handle malformed todos payloads.
    }
  }
}
