import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '../runtime/types.js';
import { SessionLifecycleState } from '../session/lifecycle.js';
import { PendingTurnBuffer } from '../session/pendingTurn.js';
import { TurnAbortController } from '../session/turnAbort.js';

function snapshot(): ContextSnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    context: {},
    filesystemRoots: [],
    cwd: undefined,
    environment: {},
  };
}

function createLifecycle() {
  const pendingTurns = new PendingTurnBuffer();
  const turnAbort = new TurnAbortController();
  const lifecycle = new SessionLifecycleState({ pendingTurns, turnAbort });

  return { lifecycle, pendingTurns, turnAbort };
}

describe('agent-sdk session lifecycle state', () => {
  it('tracks open and closed state for package-local session guards', async () => {
    const { lifecycle } = createLifecycle();

    expect(lifecycle.isClosed()).toBe(false);
    expect(() => lifecycle.assertOpen()).not.toThrow();

    await lifecycle.close();

    expect(lifecycle.isClosed()).toBe(true);
    expect(() => lifecycle.assertOpen()).toThrow('Session is closed');
  });

  it('clears pending turns and aborts active turns when closing', async () => {
    const { lifecycle, pendingTurns, turnAbort } = createLifecycle();
    const activeTurn = turnAbort.start();
    pendingTurns.enqueue({ message: 'hello', sendOptions: null, snapshot: snapshot() });

    await lifecycle.close();

    expect(pendingTurns.hasPending()).toBe(false);
    expect(activeTurn.signal.aborted).toBe(true);
    expect(turnAbort.hasActiveTurn()).toBe(false);
  });

  it('runs close cleanup once across repeated or overlapping close calls', async () => {
    const { lifecycle } = createLifecycle();
    let cleanupCalls = 0;

    await Promise.all([
      lifecycle.close(async () => {
        cleanupCalls += 1;
      }),
      lifecycle.close(async () => {
        cleanupCalls += 1;
      }),
    ]);
    await lifecycle.close(async () => {
      cleanupCalls += 1;
    });

    expect(cleanupCalls).toBe(1);
  });

  it('aborts the active turn without closing the session', () => {
    const { lifecycle, turnAbort } = createLifecycle();
    const activeTurn = turnAbort.start();

    lifecycle.abort();

    expect(activeTurn.signal.aborted).toBe(true);
    expect(turnAbort.hasActiveTurn()).toBe(false);
    expect(lifecycle.isClosed()).toBe(false);
    expect(() => lifecycle.assertOpen()).not.toThrow();
  });
});
