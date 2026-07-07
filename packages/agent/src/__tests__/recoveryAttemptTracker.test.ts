import { describe, expect, it } from 'vitest';
import { createAgentRecoveryAttemptTracker } from '../recovery/recoveryAttemptTracker.js';

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
});
