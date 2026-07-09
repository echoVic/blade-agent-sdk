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

export interface BuildAgentLoopResponseEventsInputArgs<
  Response extends {
    reasoningContent?: string;
    content?: string;
  },
  StreamingExecutionResult,
> {
  response: Response;
  signal?: AbortSignal;
  streamingExecutionResults: readonly StreamingExecutionResult[] | undefined;
}

export interface EmitAgentLoopResponseEventsFromTurnResultInput<
  Response extends {
    reasoningContent?: string;
    content?: string;
  },
  StreamingExecutionResult,
> extends BuildAgentLoopResponseEventsInputArgs<Response, StreamingExecutionResult> {}

export function buildAgentLoopResponseEventsInput<
  Response extends {
    reasoningContent?: string;
    content?: string;
  },
  StreamingExecutionResult,
>(
  input: BuildAgentLoopResponseEventsInputArgs<Response, StreamingExecutionResult>,
): AgentLoopResponseEventsInput {
  return {
    reasoningContent: input.response.reasoningContent,
    content: input.response.content,
    aborted: Boolean(input.signal?.aborted),
    hasStreamingExecutionResults: input.streamingExecutionResults !== undefined,
  };
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

export async function* emitAgentLoopResponseEventsFromTurnResult<
  Response extends {
    reasoningContent?: string;
    content?: string;
  },
  StreamingExecutionResult,
>(
  input: EmitAgentLoopResponseEventsFromTurnResultInput<
    Response,
    StreamingExecutionResult
  >,
): AsyncGenerator<AgentLoopResponseEvent, AgentLoopResponseEvent[]> {
  const events = buildAgentLoopResponseEvents(buildAgentLoopResponseEventsInput(input));
  for (const event of events) {
    yield event;
  }
  return events;
}
