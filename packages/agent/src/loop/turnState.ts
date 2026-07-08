export interface AgentLoopTurnStateFields<TPermissionMode = unknown, TExecutionContext = unknown> {
  maxContextTokens: number;
  permissionMode?: TPermissionMode;
  executionContext: TExecutionContext;
}

export interface AgentLoopTurnStateProjection<
  TTurnState extends AgentLoopTurnStateFields = AgentLoopTurnStateFields,
> {
  turnState: TTurnState;
  maxContextTokens: TTurnState['maxContextTokens'];
  permissionMode: TTurnState['permissionMode'];
  executionContext: TTurnState['executionContext'];
}

export interface AgentLoopTurnStateProjectionInput<
  TTurnState extends AgentLoopTurnStateFields = AgentLoopTurnStateFields,
> {
  turnState: TTurnState;
}

export function buildAgentLoopTurnStateProjection<
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: AgentLoopTurnStateProjectionInput<TTurnState>,
): AgentLoopTurnStateProjection<TTurnState> {
  return {
    turnState: input.turnState,
    maxContextTokens: input.turnState.maxContextTokens,
    permissionMode: input.turnState.permissionMode,
    executionContext: input.turnState.executionContext,
  };
}
