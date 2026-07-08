import { describe, expect, it } from 'vitest';
import { buildAgentRecoveryProjection } from '../recovery/recoveryEvents.js';

describe('agent recovery event projection', () => {
  it('projects recovery start state and stream event', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'started',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'started',
        reason: 'context_overflow',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'started',
        reason: 'context_overflow',
      },
    });
  });

  it('projects reactive compact failure state separately from its public stream reason', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'compact_failed',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'failed',
        reason: 'reactive_compact_failed',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'failed',
        reason: 'reactive_compact',
      },
    });
  });

  it('projects retrying state separately from its public stream reason', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'retrying',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'retrying',
        reason: 'reactive_compact_retry',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'retrying',
        reason: 'reactive_compact',
      },
    });
  });

  it('projects exhausted recovery state and stream event', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'exhausted',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'failed',
        reason: 'recovery_exhausted',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'failed',
        reason: 'recovery_exhausted',
      },
    });
  });

  it('projects recovery reset as state only', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'reset',
        turn: 2,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'reset',
        attempt: 0,
      },
    });
  });
});
