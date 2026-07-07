import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '../runtime/types.js';
import { PendingTurnBuffer } from '../session/pendingTurn.js';

function snapshot(id = 'snapshot-1'): ContextSnapshot {
  return {
    sessionId: 'session-1',
    turnId: id,
    context: {},
    filesystemRoots: [],
    cwd: undefined,
    environment: {},
  };
}

describe('agent-sdk session pending turn buffer', () => {
  it('requires send before a pending turn can be consumed', () => {
    const pending = new PendingTurnBuffer();

    expect(() => pending.take()).toThrow('No pending message. Call send() before stream().');
  });

  it('stores one pending message and clears it when consumed', () => {
    const pending = new PendingTurnBuffer();
    const queuedSnapshot = snapshot();

    pending.enqueue({
      message: 'hello',
      sendOptions: { maxTurns: 3 },
      snapshot: queuedSnapshot,
    });

    expect(pending.hasPending()).toBe(true);
    expect(pending.take()).toEqual({
      message: 'hello',
      sendOptions: { maxTurns: 3 },
      snapshot: queuedSnapshot,
    });
    expect(pending.hasPending()).toBe(false);
    expect(() => pending.take()).toThrow('No pending message. Call send() before stream().');
  });

  it('rejects a second pending message until the current one is consumed', () => {
    const pending = new PendingTurnBuffer();

    pending.enqueue({ message: 'first', sendOptions: null, snapshot: snapshot('snapshot-1') });

    expect(() =>
      pending.enqueue({ message: 'second', sendOptions: null, snapshot: snapshot('snapshot-2') }),
    ).toThrow('Cannot send a new message while a previous message is pending. Call stream() first.');

    expect(pending.take().message).toBe('first');
  });

  it('clears pending state for close or abort cleanup', () => {
    const pending = new PendingTurnBuffer();

    pending.enqueue({ message: 'hello', sendOptions: null, snapshot: snapshot() });
    pending.clear();

    expect(pending.hasPending()).toBe(false);
    expect(() => pending.take()).toThrow('No pending message. Call send() before stream().');
  });
});
