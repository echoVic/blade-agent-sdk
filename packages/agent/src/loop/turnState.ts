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

export interface AgentLoopTurnStatePreparationInput<
  TTurnState extends AgentLoopTurnStateFields = AgentLoopTurnStateFields,
> {
  prepareTurnState(turn: number): TTurnState;
  turn: number;
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

export function buildAgentLoopTurnStateProjectionFromPreparation<
  TTurnState extends AgentLoopTurnStateFields,
>(
  input: AgentLoopTurnStatePreparationInput<TTurnState>,
): AgentLoopTurnStateProjection<TTurnState> {
  return buildAgentLoopTurnStateProjection({
    turnState: input.prepareTurnState(input.turn),
  });
}
