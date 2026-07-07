import { describe, expect, it } from 'vitest';
import type { RuntimeContext } from '../runtime/types.js';
import { SessionLifecycleState } from '../session/lifecycle.js';
import { PendingTurnBuffer } from '../session/pendingTurn.js';
import { SessionTurnController } from '../session/turn.js';
import { TurnAbortController } from '../session/turnAbort.js';

function createTurnController(defaultContext: RuntimeContext = {}) {
  const pendingTurns = new PendingTurnBuffer();
  const turnAbort = new TurnAbortController();
  const lifecycle = new SessionLifecycleState({ pendingTurns, turnAbort });
  let turnIndex = 0;
  const turns = new SessionTurnController({
    sessionId: 'session-1',
    pendingTurns,
    turnAbort,
    lifecycle,
    getDefaultContext: () => defaultContext,
    createTurnId: () => `turn-${++turnIndex}`,
  });

  return { turns, pendingTurns, turnAbort, lifecycle };
}

describe('agent-sdk session turn controller', () => {
  it('queues a pending turn with a package-local context snapshot', () => {
    const { turns, pendingTurns } = createTurnController({
      capabilities: {
        filesystem: {
          roots: ['/session-root'],
          cwd: '/session-root',
        },
        network: {
          allowDomains: ['example.com'],
        },
      },
      environment: {
        SHARED: 'session',
        SESSION_ONLY: 'yes',
      },
      metadata: {
        source: 'session',
      },
    });

    turns.send('hello', {
      maxTurns: 3,
      context: {
        capabilities: {
          filesystem: {
            roots: ['/turn-root'],
            cwd: '/turn-root',
          },
        },
        environment: {
          SHARED: 'turn',
          TURN_ONLY: 'yes',
        },
        metadata: {
          requestId: 'req-1',
        },
      },
    });

    const pending = pendingTurns.take();
    expect(pending.message).toBe('hello');
    expect(pending.sendOptions?.maxTurns).toBe(3);
    expect(pending.snapshot).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      context: {
        capabilities: {
          filesystem: {
            roots: ['/turn-root'],
            cwd: '/turn-root',
          },
          network: {
            allowDomains: ['example.com'],
          },
        },
        environment: {
          SHARED: 'turn',
          SESSION_ONLY: 'yes',
          TURN_ONLY: 'yes',
        },
        metadata: {
          source: 'session',
          requestId: 'req-1',
        },
      },
      filesystemRoots: ['/turn-root'],
      cwd: '/turn-root',
      environment: {
        SHARED: 'turn',
        SESSION_ONLY: 'yes',
        TURN_ONLY: 'yes',
      },
    });
  });

  it('begins a stream turn by consuming pending state and opening an abort scope', () => {
    const { turns, pendingTurns, turnAbort } = createTurnController();

    turns.send('hello');
    const activeTurn = turns.beginStreamTurn();

    expect(activeTurn.message).toBe('hello');
    expect(activeTurn.sendOptions).toBeNull();
    expect(activeTurn.signal.aborted).toBe(false);
    expect(pendingTurns.hasPending()).toBe(false);
    expect(turnAbort.hasActiveTurn()).toBe(true);

    activeTurn.cleanup();

    expect(turnAbort.hasActiveTurn()).toBe(false);
  });

  it('propagates external abort signals into the active stream turn', () => {
    const { turns, turnAbort } = createTurnController();
    const external = new AbortController();

    turns.send('hello', { signal: external.signal });
    const activeTurn = turns.beginStreamTurn();
    external.abort();

    expect(activeTurn.signal.aborted).toBe(true);
    expect(turnAbort.hasActiveTurn()).toBe(false);
  });

  it('rejects send and stream preparation after lifecycle close', async () => {
    const { turns, lifecycle } = createTurnController();

    turns.send('queued');
    await lifecycle.close();

    expect(() => turns.send('late')).toThrow('Session is closed');
    expect(() => turns.beginStreamTurn()).toThrow('Session is closed');
  });
});
