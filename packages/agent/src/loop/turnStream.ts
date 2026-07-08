export interface AgentLoopTurnStreamOutcome<TTurnResult, TStreamingExecutionResult> {
  chatResponse: TTurnResult;
  streamingExecutionResults?: TStreamingExecutionResult[];
}

export interface AgentLoopTurnStreamResult<TTurnResult, TStreamingExecutionResult> {
  turnResult: TTurnResult;
  streamingExecutionResults?: TStreamingExecutionResult[];
}

export interface AgentLoopRunTurnInput<
  TTurnState,
  TMessages,
  TExecutionPipeline,
  TEpoch,
  TExecutionContext,
  TPermissionMode,
  TLogger,
  TToolHooks,
> {
  turnState: TTurnState;
  messages: TMessages;
  executionPipeline: TExecutionPipeline;
  streaming?: boolean;
  signal?: AbortSignal;
  epoch: TEpoch;
  executionContext: TExecutionContext;
  permissionMode?: TPermissionMode;
  logger?: TLogger;
  toolHooks: TToolHooks;
}

export interface AgentLoopRunTurnToolHooksInput<
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
> {
  beforeExec?: TBeforeExec;
  afterExec?: TAfterExec;
  afterExecEpochDiscard?: TAfterExecEpochDiscard;
  onUpdate?: TOnUpdate;
}

export interface AgentLoopRunTurnToolHooks<
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
> {
  onBeforeExec?: TBeforeExec;
  onAfterExec?: TAfterExec;
  onAfterExecEpochDiscard?: TAfterExecEpochDiscard;
  onUpdate?: TOnUpdate;
}

export function buildAgentLoopRunTurnToolHooksInput<
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate,
>(
  input: AgentLoopRunTurnToolHooksInput<
    TBeforeExec,
    TAfterExec,
    TAfterExecEpochDiscard,
    TOnUpdate
  >,
): AgentLoopRunTurnToolHooks<
  TBeforeExec,
  TAfterExec,
  TAfterExecEpochDiscard,
  TOnUpdate
> {
  return {
    onBeforeExec: input.beforeExec,
    onAfterExec: input.afterExec,
    onAfterExecEpochDiscard: input.afterExecEpochDiscard,
    onUpdate: input.onUpdate,
  };
}

export function buildAgentLoopRunTurnInput<
  TTurnState,
  TMessages,
  TExecutionPipeline,
  TEpoch,
  TExecutionContext,
  TPermissionMode,
  TLogger,
  TToolHooks,
>(
  input: AgentLoopRunTurnInput<
    TTurnState,
    TMessages,
    TExecutionPipeline,
    TEpoch,
    TExecutionContext,
    TPermissionMode,
    TLogger,
    TToolHooks
  >,
): AgentLoopRunTurnInput<
  TTurnState,
  TMessages,
  TExecutionPipeline,
  TEpoch,
  TExecutionContext,
  TPermissionMode,
  TLogger,
  TToolHooks
> {
  return {
    turnState: input.turnState,
    messages: input.messages,
    executionPipeline: input.executionPipeline,
    streaming: input.streaming,
    signal: input.signal,
    epoch: input.epoch,
    executionContext: input.executionContext,
    permissionMode: input.permissionMode,
    logger: input.logger,
    toolHooks: input.toolHooks,
  };
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
