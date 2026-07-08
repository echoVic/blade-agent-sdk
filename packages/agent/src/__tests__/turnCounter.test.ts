import { describe, expect, it } from 'vitest';
import {
  createAgentLoopTurnCounter,
  shouldEmitAgentLoopTurnStart,
} from '../loop/turnCounter.js';

describe('agent loop turn counter', () => {
  it('starts before the first turn and allows before-turn hooks', () => {
    const counter = createAgentLoopTurnCounter();

    expect(counter.turnsCount).toBe(0);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
    expect(counter.previousCompletedTurnCount).toBe(0);
  });

  it('starts new turns by incrementing the visible turn count', () => {
    const counter = createAgentLoopTurnCounter();

    expect(counter.beginTurn()).toEqual({ started: true, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.previousCompletedTurnCount).toBe(0);

    expect(counter.beginTurn()).toEqual({ started: true, turn: 2 });
    expect(counter.turnsCount).toBe(2);
    expect(counter.previousCompletedTurnCount).toBe(1);
  });

  it('emits turn-start events only for newly started turns', () => {
    expect(shouldEmitAgentLoopTurnStart({ started: true, turn: 1 })).toBe(true);
    expect(shouldEmitAgentLoopTurnStart({ started: false, turn: 1 })).toBe(false);
  });

  it('retries the current turn without rerunning before-turn hooks or incrementing', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    counter.requestRetry();

    expect(counter.shouldRunBeforeTurn()).toBe(false);
    expect(counter.beginTurn()).toEqual({ started: false, turn: 1 });
    expect(counter.turnsCount).toBe(1);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
  });

  it('resets turn counting after turn-limit compaction continues the loop', () => {
    const counter = createAgentLoopTurnCounter();

    counter.beginTurn();
    counter.beginTurn();
    counter.requestRetry();
    counter.reset();

    expect(counter.turnsCount).toBe(0);
    expect(counter.previousCompletedTurnCount).toBe(0);
    expect(counter.shouldRunBeforeTurn()).toBe(true);
    expect(counter.beginTurn()).toEqual({ started: true, turn: 1 });
  });
});
