import { describe, expect, it } from 'vitest';
import { TurnAbortController } from '../session/turnAbort.js';

describe('agent-sdk session turn abort controller', () => {
  it('creates a local turn signal and clears it during cleanup', () => {
    const turns = new TurnAbortController();
    const turn = turns.start();

    expect(turn.signal.aborted).toBe(false);
    expect(turns.hasActiveTurn()).toBe(true);

    turn.cleanup();

    expect(turns.hasActiveTurn()).toBe(false);
  });

  it('propagates external aborts to the active turn signal', () => {
    const turns = new TurnAbortController();
    const external = new AbortController();
    const turn = turns.start(external.signal);

    external.abort();

    expect(turn.signal.aborted).toBe(true);
    expect(turns.hasActiveTurn()).toBe(false);
  });

  it('aborts the active turn when the session aborts', () => {
    const turns = new TurnAbortController();
    const external = new AbortController();
    const turn = turns.start(external.signal);

    turns.abort();

    expect(turn.signal.aborted).toBe(true);
    expect(turns.hasActiveTurn()).toBe(false);
  });

  it('disconnects external abort listeners during cleanup', () => {
    const turns = new TurnAbortController();
    const external = new AbortController();
    const turn = turns.start(external.signal);

    turn.cleanup();
    external.abort();

    expect(turn.signal.aborted).toBe(false);
    expect(turns.hasActiveTurn()).toBe(false);
  });

  it('rejects overlapping active turns', () => {
    const turns = new TurnAbortController();
    const turn = turns.start();

    expect(() => turns.start()).toThrow(
      'Cannot start a new turn while a previous turn abort scope is active.',
    );

    turn.cleanup();
    expect(() => turns.start()).not.toThrow();
  });
});
