import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopEndEvent,
  buildAgentLoopStartEvent,
  buildAgentLoopToolTurnCompletion,
  buildAgentLoopToolTurnCompletionInput,
  buildAgentLoopTurnEndEvent,
  buildAgentLoopTurnRetryEvent,
  buildAgentLoopTurnRetryEventInput,
  buildAgentLoopTurnStartEventInput,
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

  it('projects turn start event input with turn and effective max turn count', () => {
    expect(buildAgentLoopTurnStartEventInput({ turn: 2, maxTurns: 8 })).toEqual({
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

  it('builds tool-turn completion events with stable tool-call status', () => {
    expect(buildAgentLoopToolTurnCompletion({ turn: 6 })).toEqual({
      events: [{ type: 'turn_end', turn: 6, hasToolCalls: true }],
    });
  });

  it('projects tool-turn completion input from the current turn', () => {
    expect(buildAgentLoopToolTurnCompletionInput({ turn: 6 })).toEqual({
      turn: 6,
    });
  });

  it('builds retry events for reactive compaction', () => {
    expect(buildAgentLoopTurnRetryEvent({ turn: 5, reason: 'reactive_compact' })).toEqual({
      type: 'turn_retry',
      turn: 5,
      reason: 'reactive_compact',
    });
  });

  it('projects retry event input for reactive compaction', () => {
    expect(buildAgentLoopTurnRetryEventInput({ turn: 5, reason: 'reactive_compact' })).toEqual({
      turn: 5,
      reason: 'reactive_compact',
    });
  });
});
