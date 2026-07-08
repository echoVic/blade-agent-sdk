export interface AgentLoopThinkingEvent {
  type: 'thinking';
  content: string;
}

export interface AgentLoopStreamEndEvent {
  type: 'stream_end';
}

export type AgentLoopResponseEvent = AgentLoopThinkingEvent | AgentLoopStreamEndEvent;

export interface AgentLoopResponseEventsInput {
  reasoningContent?: string;
  content?: string;
  aborted: boolean;
  hasStreamingExecutionResults: boolean;
}

export function buildAgentLoopResponseEvents(
  input: AgentLoopResponseEventsInput,
): AgentLoopResponseEvent[] {
  if (input.aborted) {
    return [];
  }

  const events: AgentLoopResponseEvent[] = [];

  if (input.reasoningContent) {
    events.push({ type: 'thinking', content: input.reasoningContent });
  }

  if (input.content?.trim() && !input.hasStreamingExecutionResults) {
    events.push({ type: 'stream_end' });
  }

  return events;
}
