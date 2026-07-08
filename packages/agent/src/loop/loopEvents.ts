export interface AgentLoopStartEvent {
  type: 'agent_start';
}

export interface AgentLoopEndEvent {
  type: 'agent_end';
}

export interface AgentLoopTurnStartEvent {
  type: 'turn_start';
  turn: number;
  maxTurns: number;
}

export interface AgentLoopTurnEndEvent {
  type: 'turn_end';
  turn: number;
  hasToolCalls: boolean;
}

export interface AgentLoopTurnRetryEvent {
  type: 'turn_retry';
  turn: number;
  reason: 'reactive_compact';
}

export interface AgentLoopTurnStartEventInput {
  turn: number;
  maxTurns: number;
}

export interface AgentLoopTurnEndEventInput {
  turn: number;
  hasToolCalls: boolean;
}

export interface AgentLoopTurnRetryEventInput {
  turn: number;
  reason: 'reactive_compact';
}

export interface AgentLoopToolTurnCompletionInput {
  turn: number;
}

export interface AgentLoopToolTurnCompletion {
  events: [AgentLoopTurnEndEvent];
}

export function buildAgentLoopStartEvent(): AgentLoopStartEvent {
  return { type: 'agent_start' };
}

export function buildAgentLoopEndEvent(): AgentLoopEndEvent {
  return { type: 'agent_end' };
}

export function buildAgentLoopTurnStartEventInput(
  input: AgentLoopTurnStartEventInput,
): AgentLoopTurnStartEventInput {
  return {
    turn: input.turn,
    maxTurns: input.maxTurns,
  };
}

export function buildAgentLoopTurnStartEvent(
  input: AgentLoopTurnStartEventInput,
): AgentLoopTurnStartEvent {
  return {
    type: 'turn_start',
    turn: input.turn,
    maxTurns: input.maxTurns,
  };
}

export function buildAgentLoopTurnEndEvent(
  input: AgentLoopTurnEndEventInput,
): AgentLoopTurnEndEvent {
  return {
    type: 'turn_end',
    turn: input.turn,
    hasToolCalls: input.hasToolCalls,
  };
}

export function buildAgentLoopToolTurnCompletion(
  input: AgentLoopToolTurnCompletionInput,
): AgentLoopToolTurnCompletion {
  return {
    events: [buildAgentLoopTurnEndEvent({ turn: input.turn, hasToolCalls: true })],
  };
}

export function buildAgentLoopTurnRetryEvent(
  input: AgentLoopTurnRetryEventInput,
): AgentLoopTurnRetryEvent {
  return {
    type: 'turn_retry',
    turn: input.turn,
    reason: input.reason,
  };
}
