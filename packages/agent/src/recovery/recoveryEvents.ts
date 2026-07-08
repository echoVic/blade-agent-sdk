export type AgentRecoveryProjectionKind =
  | 'started'
  | 'compact_failed'
  | 'retrying'
  | 'exhausted'
  | 'reset';

export type AgentRecoveryStatePhase = 'started' | 'retrying' | 'failed' | 'reset';

export type AgentRecoveryStateReason =
  | 'context_overflow'
  | 'reactive_compact_failed'
  | 'reactive_compact_retry'
  | 'recovery_exhausted';

export type AgentRecoveryEventReason =
  | 'context_overflow'
  | 'reactive_compact'
  | 'recovery_exhausted';

export interface AgentRecoveryStateChange {
  turn: number;
  phase: AgentRecoveryStatePhase;
  reason?: AgentRecoveryStateReason;
  attempt: number;
}

export interface AgentRecoveryEvent {
  type: 'recovery';
  phase: 'started' | 'retrying' | 'failed';
  reason: AgentRecoveryEventReason;
}

export type AgentRecoveryProjectionInput =
  | {
      kind: Exclude<AgentRecoveryProjectionKind, 'reset'>;
      turn: number;
      attempt: number;
    }
  | {
      kind: 'reset';
      turn: number;
    };

export interface AgentRecoveryProjection {
  stateChange: AgentRecoveryStateChange;
  event?: AgentRecoveryEvent;
}

export function buildAgentRecoveryProjection(
  input: AgentRecoveryProjectionInput,
): AgentRecoveryProjection {
  switch (input.kind) {
    case 'started':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'started',
          reason: 'context_overflow',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'started',
          reason: 'context_overflow',
        },
      };
    case 'compact_failed':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'failed',
          reason: 'reactive_compact_failed',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'failed',
          reason: 'reactive_compact',
        },
      };
    case 'retrying':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'retrying',
          reason: 'reactive_compact',
        },
      };
    case 'exhausted':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'failed',
          reason: 'recovery_exhausted',
        },
      };
    case 'reset':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'reset',
          attempt: 0,
        },
      };
  }
}
