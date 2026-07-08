import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopEndEvent,
  buildAgentLoopStartEvent,
  buildAgentLoopTurnEndEvent,
  buildAgentLoopTurnRetryEvent,
  buildAgentLoopTurnStartEvent,
} from '../loop/loopEvents.js';

describe('agent loop lifecycle event builders', () => {
  it('builds agent lifecycle boundary events', () => {
    expect(buildAgentLoopStartEvent()).toEqual({ type: 'agent_start' });
    expect(buildAgentLoopEndEvent()).toEqual({ type: 'agent_end' });
  });

  it('builds turn start events with the effective max turn count', () => {
    expect(buildAgentLoopTurnStartEvent({ turn: 2, maxTurns: 8 })).toEqual({
      type: 'turn_start',
      turn: 2,
      maxTurns: 8,
    });
  });

  it('builds turn end events with tool-call status', () => {
    expect(buildAgentLoopTurnEndEvent({ turn: 3, hasToolCalls: true })).toEqual({
      type: 'turn_end',
      turn: 3,
      hasToolCalls: true,
    });

    expect(buildAgentLoopTurnEndEvent({ turn: 4, hasToolCalls: false })).toEqual({
      type: 'turn_end',
      turn: 4,
      hasToolCalls: false,
    });
  });

  it('builds retry events for reactive compaction', () => {
    expect(buildAgentLoopTurnRetryEvent({ turn: 5, reason: 'reactive_compact' })).toEqual({
      type: 'turn_retry',
      turn: 5,
      reason: 'reactive_compact',
    });
  });
});
