export interface AgentLoopTurnStreamOutcome<TTurnResult, TStreamingExecutionResult> {
  chatResponse: TTurnResult;
  streamingExecutionResults?: TStreamingExecutionResult[];
}

export interface AgentLoopTurnStreamResult<TTurnResult, TStreamingExecutionResult> {
  turnResult: TTurnResult;
  streamingExecutionResults?: TStreamingExecutionResult[];
}

export async function* consumeAgentLoopTurnStream<
  Event,
  TTurnResult,
  TStreamingExecutionResult,
>(
  stream: AsyncGenerator<
    Event,
    AgentLoopTurnStreamOutcome<TTurnResult, TStreamingExecutionResult>
  >,
): AsyncGenerator<Event, AgentLoopTurnStreamResult<TTurnResult, TStreamingExecutionResult>> {
  while (true) {
    const { value, done } = await stream.next();
    if (done) {
      return {
        turnResult: value.chatResponse,
        streamingExecutionResults: value.streamingExecutionResults,
      };
    }
    yield value;
  }
}
