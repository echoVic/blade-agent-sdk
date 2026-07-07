import { describe, expect, it } from 'vitest';
import { createAgentLoopClock } from '../loop/loopClock.js';

describe('agent loop clock', () => {
  it('captures the loop start time when created', () => {
    const nowValues = [100, 175];
    const clock = createAgentLoopClock({ now: () => nowValues.shift() ?? 999 });

    expect(clock.startTime).toBe(100);
    expect(clock.startTime).toBe(100);
  });

  it('builds result timing from the captured start time and current time', () => {
    const nowValues = [100, 175];
    const clock = createAgentLoopClock({ now: () => nowValues.shift() ?? 999 });

    expect(clock.resultTiming({ turnsCount: 2, toolCallsCount: 3 })).toEqual({
      turnsCount: 2,
      toolCallsCount: 3,
      startTime: 100,
      now: 175,
    });
  });
});
