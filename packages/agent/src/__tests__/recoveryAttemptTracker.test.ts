import { describe, expect, it } from 'vitest';
import {
  buildAgentRecoveryExhaustedEffectsFromTracker,
  buildAgentRecoveryExhaustedProjectionInputFromTracker,
  consumeAgentRecoveryResetAttempt,
  consumeAgentRecoveryResetEffects,
  createAgentRecoveryAttemptTracker,
  hasAgentRecoveryAttemptExhausted,
  shouldAttemptAgentRecovery,
  startAgentRecoveryAttempt,
  startAgentRecoveryAttemptWithStartedEffects,
} from '../recovery/recoveryAttemptTracker.js';

describe('agent recovery attempt tracker', () => {
  it('starts without an active recovery attempt', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(tracker.attempt).toBe(0);
    expect(tracker.canAttempt(1)).toBe(true);
    expect(tracker.hasAttemptedTurn(1)).toBe(false);
    expect(tracker.consumeResetAttempt()).toBeNull();
  });

  it('records a single recovery attempt for a turn', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(tracker.startAttempt(3)).toBe(1);

    expect(tracker.attempt).toBe(1);
    expect(tracker.canAttempt(3)).toBe(false);
    expect(tracker.canAttempt(4)).toBe(true);
    expect(tracker.hasAttemptedTurn(3)).toBe(true);
  });

  it('does not double-count duplicate start calls for the same turn', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(tracker.startAttempt(3)).toBe(1);
    expect(tracker.startAttempt(3)).toBe(1);

    expect(tracker.attempt).toBe(1);
    expect(tracker.canAttempt(3)).toBe(false);
  });

  it('starts recovery attempts through the package helper', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(startAgentRecoveryAttempt({ tracker, turn: 3 })).toBe(1);
    expect(startAgentRecoveryAttempt({ tracker, turn: 3 })).toBe(1);
    expect(startAgentRecoveryAttempt({ tracker, turn: 4 })).toBe(2);

    expect(tracker.attempt).toBe(2);
    expect(tracker.hasAttemptedTurn(4)).toBe(true);
  });

  it('starts recovery attempts with started effects for the current turn', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(startAgentRecoveryAttemptWithStartedEffects({ tracker, turn: 6 })).toEqual({
      attempt: 1,
      effects: {
        stateChanges: [
          {
            turn: 6,
            phase: 'started',
            reason: 'context_overflow',
            attempt: 1,
          },
        ],
        events: [
          {
            type: 'recovery',
            phase: 'started',
            reason: 'context_overflow',
          },
        ],
      },
    });
    expect(tracker.attempt).toBe(1);
    expect(tracker.hasAttemptedTurn(6)).toBe(true);
  });

  it('increments attempts across consecutive failed turns until reset is consumed', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(tracker.startAttempt(1)).toBe(1);
    expect(tracker.startAttempt(2)).toBe(2);

    expect(tracker.attempt).toBe(2);
    expect(tracker.consumeResetAttempt()).toBe(2);
    expect(tracker.attempt).toBe(0);
    expect(tracker.canAttempt(2)).toBe(true);
  });

  it('resets after a successful recovery so the same turn can be attempted again later', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    tracker.startAttempt(1);
    expect(tracker.consumeResetAttempt()).toBe(1);

    expect(tracker.startAttempt(1)).toBe(1);
    expect(tracker.hasAttemptedTurn(1)).toBe(true);
  });

  it('reports no reset when there is no consumed recovery attempt', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(consumeAgentRecoveryResetAttempt(tracker)).toBe(false);
  });

  it('consumes and reports a reset after a recovery attempt', () => {
    const tracker = createAgentRecoveryAttemptTracker();
    tracker.startAttempt(2);

    expect(consumeAgentRecoveryResetAttempt(tracker)).toBe(true);
    expect(tracker.attempt).toBe(0);
    expect(tracker.canAttempt(2)).toBe(true);
    expect(consumeAgentRecoveryResetAttempt(tracker)).toBe(false);
  });

  it('consumes reset attempts with reset effects for the current turn', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(consumeAgentRecoveryResetEffects({ tracker, turn: 7 })).toBeNull();

    tracker.startAttempt(6);

    expect(consumeAgentRecoveryResetEffects({ tracker, turn: 7 })).toEqual({
      stateChanges: [
        {
          turn: 7,
          phase: 'reset',
          attempt: 0,
        },
      ],
      events: [],
    });
    expect(tracker.attempt).toBe(0);
    expect(tracker.canAttempt(6)).toBe(true);
    expect(consumeAgentRecoveryResetEffects({ tracker, turn: 8 })).toBeNull();
  });

  it('allows reactive recovery only for recoverable errors with a compact hook and remaining attempts', () => {
    const tracker = createAgentRecoveryAttemptTracker();

    expect(
      shouldAttemptAgentRecovery({
        error: new Error('maximum context length exceeded'),
        hasReactiveCompact: true,
        tracker,
        turn: 4,
      }),
    ).toBe(true);

    tracker.startAttempt(4);

    expect(
      shouldAttemptAgentRecovery({
        error: new Error('maximum context length exceeded'),
        hasReactiveCompact: true,
        tracker,
        turn: 4,
      }),
    ).toBe(false);
    expect(
      shouldAttemptAgentRecovery({
        error: new Error('plain provider failure'),
        hasReactiveCompact: true,
        tracker,
        turn: 5,
      }),
    ).toBe(false);
    expect(
      shouldAttemptAgentRecovery({
        error: new Error('maximum context length exceeded'),
        hasReactiveCompact: false,
        tracker,
        turn: 5,
      }),
    ).toBe(false);
  });

  it('reports recovery exhaustion only for recoverable errors already attempted on the turn', () => {
    const tracker = createAgentRecoveryAttemptTracker();
    tracker.startAttempt(3);

    expect(
      hasAgentRecoveryAttemptExhausted({
        error: new Error('too many tokens'),
        tracker,
        turn: 3,
      }),
    ).toBe(true);
    expect(
      hasAgentRecoveryAttemptExhausted({
        error: new Error('too many tokens'),
        tracker,
        turn: 4,
      }),
    ).toBe(false);
    expect(
      hasAgentRecoveryAttemptExhausted({
        error: new Error('plain provider failure'),
        tracker,
        turn: 3,
      }),
    ).toBe(false);
  });

  it('projects recovery exhaustion input from tracker state', () => {
    const tracker = createAgentRecoveryAttemptTracker();
    tracker.startAttempt(4);
    tracker.startAttempt(5);

    expect(
      buildAgentRecoveryExhaustedProjectionInputFromTracker({
        tracker,
        turn: 5,
      }),
    ).toEqual({
      kind: 'exhausted',
      turn: 5,
      attempt: 2,
    });
  });

  it('builds recovery exhausted effects from tracker state', () => {
    const tracker = createAgentRecoveryAttemptTracker();
    tracker.startAttempt(4);
    tracker.startAttempt(5);

    expect(
      buildAgentRecoveryExhaustedEffectsFromTracker({
        tracker,
        turn: 5,
      }),
    ).toEqual({
      stateChanges: [
        {
          turn: 5,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: 2,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'failed',
          reason: 'recovery_exhausted',
        },
      ],
    });
  });
});
